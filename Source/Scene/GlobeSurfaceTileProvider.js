define([
        '../Core/AttributeCompression',
        '../Core/BoundingSphere',
        '../Core/BoxOutlineGeometry',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Cartographic',
        '../Core/Color',
        '../Core/ColorGeometryInstanceAttribute',
        '../Core/combine',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/Event',
        '../Core/GeometryInstance',
        '../Core/GeometryPipeline',
        '../Core/IndexDatatype',
        '../Core/Intersect',
        '../Core/Math',
        '../Core/Matrix3',
        '../Core/Matrix4',
        '../Core/OrientedBoundingBox',
        '../Core/OrthographicFrustum',
        '../Core/PrimitiveType',
        '../Core/Rectangle',
        '../Core/SphereOutlineGeometry',
        '../Core/TerrainEncoding',
        '../Core/TerrainMesh',
        '../Core/TerrainQuantization',
        '../Core/TerrainTileEdgeDetails',
        '../Core/TileEdge',
        '../Core/Visibility',
        '../Core/WebMercatorProjection',
        '../Renderer/Buffer',
        '../Renderer/BufferUsage',
        '../Renderer/ContextLimits',
        '../Renderer/DrawCommand',
        '../Renderer/Pass',
        '../Renderer/RenderState',
        '../Renderer/VertexArray',
        './BlendingState',
        './DepthFunction',
        './ImageryState',
        './PerInstanceColorAppearance',
        './Primitive',
        './TileBoundingRegion',
        './TileSelectionResult',
        './ClippingPlaneCollection',
        './GlobeSurfaceTile',
        './ImageryLayer',
        './QuadtreeTileLoadState',
        './SceneMode',
        './ShadowMode'
    ], function(
        AttributeCompression,
        BoundingSphere,
        BoxOutlineGeometry,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        Cartographic,
        Color,
        ColorGeometryInstanceAttribute,
        combine,
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        DeveloperError,
        Event,
        GeometryInstance,
        GeometryPipeline,
        IndexDatatype,
        Intersect,
        CesiumMath,
        Matrix3,
        Matrix4,
        OrientedBoundingBox,
        OrthographicFrustum,
        PrimitiveType,
        Rectangle,
        SphereOutlineGeometry,
        TerrainEncoding,
        TerrainMesh,
        TerrainQuantization,
        TerrainTileEdgeDetails,
        TileEdge,
        Visibility,
        WebMercatorProjection,
        Buffer,
        BufferUsage,
        ContextLimits,
        DrawCommand,
        Pass,
        RenderState,
        VertexArray,
        BlendingState,
        DepthFunction,
        ImageryState,
        PerInstanceColorAppearance,
        Primitive,
        TileBoundingRegion,
        TileSelectionResult,
        ClippingPlaneCollection,
        GlobeSurfaceTile,
        ImageryLayer,
        QuadtreeTileLoadState,
        SceneMode,
        ShadowMode) {
    'use strict';

    /**
     * The strategy to use to fill the space of tiles that are selected for rendering but that
     * are not yet loaded / renderable.
     * @private
     */
    var MissingTileStrategy = {
        /**
         * Render nothing, the globe will have holes during load.
         */
        RENDER_NOTHING: 0,

        /**
         * Render a subset of the closest renderable ancestor. This is cheap on the CPU, but can be very expensive in terms
         * of GPU fill rate. It also leads to cracking due to missing skirts.
         */
        RENDER_ANCESTOR_SUBSET: 1,

        /**
         * Create a very simple tile to fill the space by matching the heights of adjacent tiles on the edges. This is
         * cheaper on the CPU than a full upsample and avoids cracks. But it's less representative of the real
         * terrain surface than an upsample from a nearby ancestor.
         */
        CREATE_FILL_TILE: 2

        /**
         * Synchronously upsample the tile. This is expensive on the CPU and, when skipping several levels, it sometimes
         * results in big cracks anyway. (currently not implemented)
         */
        // SYNCHRONOUS_UPSAMPLE: 3
    };

    /**
     * Provides quadtree tiles representing the surface of the globe.  This type is intended to be used
     * with {@link QuadtreePrimitive}.
     *
     * @alias GlobeSurfaceTileProvider
     * @constructor
     *
     * @param {TerrainProvider} options.terrainProvider The terrain provider that describes the surface geometry.
     * @param {ImageryLayerCollection} option.imageryLayers The collection of imagery layers describing the shading of the surface.
     * @param {GlobeSurfaceShaderSet} options.surfaceShaderSet The set of shaders used to render the surface.
     *
     * @private
     */
    function GlobeSurfaceTileProvider(options) {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(options)) {
            throw new DeveloperError('options is required.');
        }
        if (!defined(options.terrainProvider)) {
            throw new DeveloperError('options.terrainProvider is required.');
        } else if (!defined(options.imageryLayers)) {
            throw new DeveloperError('options.imageryLayers is required.');
        } else if (!defined(options.surfaceShaderSet)) {
            throw new DeveloperError('options.surfaceShaderSet is required.');
        }
        //>>includeEnd('debug');

        this.lightingFadeOutDistance = 6500000.0;
        this.lightingFadeInDistance = 9000000.0;
        this.hasWaterMask = false;
        this.oceanNormalMap = undefined;
        this.zoomedOutOceanSpecularIntensity = 0.5;
        this.enableLighting = false;
        this.shadows = ShadowMode.RECEIVE_ONLY;

        /**
         * The strategy to use to fill holes in the globe when terrain tiles are not yet loaded.
         */
        this.missingTileStrategy = MissingTileStrategy.CREATE_FILL_TILE;

        this._quadtree = undefined;
        this._terrainProvider = options.terrainProvider;
        this._imageryLayers = options.imageryLayers;
        this._surfaceShaderSet = options.surfaceShaderSet;

        this._renderState = undefined;
        this._blendRenderState = undefined;

        this._errorEvent = new Event();

        this._imageryLayers.layerAdded.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerAdded, this);
        this._imageryLayers.layerRemoved.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerRemoved, this);
        this._imageryLayers.layerMoved.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerMoved, this);
        this._imageryLayers.layerShownOrHidden.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerShownOrHidden, this);
        this._tileLoadedEvent = new Event();
        this._imageryLayersUpdatedEvent = new Event();

        this._layerOrderChanged = false;

        this._tilesToRenderByTextureCount = [];
        this._drawCommands = [];
        this._uniformMaps = [];
        this._usedDrawCommands = 0;

        this._vertexArraysToDestroy = [];

        this._debug = {
            wireframe : false,
            boundingSphereTile : undefined
        };

        this._baseColor = undefined;
        this._firstPassInitialColor = undefined;
        this.baseColor = new Color(0.0, 0.0, 0.5, 1.0);

        /**
         * A property specifying a {@link ClippingPlaneCollection} used to selectively disable rendering on the outside of each plane.
         * @type {ClippingPlaneCollection}
         * @private
         */
        this._clippingPlanes = undefined;
    }

    defineProperties(GlobeSurfaceTileProvider.prototype, {
        /**
         * Gets or sets the color of the globe when no imagery is available.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Color}
         */
        baseColor : {
            get : function() {
                return this._baseColor;
            },
            set : function(value) {
                //>>includeStart('debug', pragmas.debug);
                if (!defined(value)) {
                    throw new DeveloperError('value is required.');
                }
                //>>includeEnd('debug');

                this._baseColor = value;
                this._firstPassInitialColor = Cartesian4.fromColor(value, this._firstPassInitialColor);
            }
        },
        /**
         * Gets or sets the {@link QuadtreePrimitive} for which this provider is
         * providing tiles.  This property may be undefined if the provider is not yet associated
         * with a {@link QuadtreePrimitive}.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {QuadtreePrimitive}
         */
        quadtree : {
            get : function() {
                return this._quadtree;
            },
            set : function(value) {
                //>>includeStart('debug', pragmas.debug);
                if (!defined(value)) {
                    throw new DeveloperError('value is required.');
                }
                //>>includeEnd('debug');

                this._quadtree = value;
            }
        },

        /**
         * Gets a value indicating whether or not the provider is ready for use.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Boolean}
         */
        ready : {
            get : function() {
                return this._terrainProvider.ready && (this._imageryLayers.length === 0 || this._imageryLayers.get(0).imageryProvider.ready);
            }
        },

        /**
         * Gets the tiling scheme used by the provider.  This property should
         * not be accessed before {@link GlobeSurfaceTileProvider#ready} returns true.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {TilingScheme}
         */
        tilingScheme : {
            get : function() {
                return this._terrainProvider.tilingScheme;
            }
        },

        /**
         * Gets an event that is raised when the geometry provider encounters an asynchronous error.  By subscribing
         * to the event, you will be notified of the error and can potentially recover from it.  Event listeners
         * are passed an instance of {@link TileProviderError}.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Event}
         */
        errorEvent : {
            get : function() {
                return this._errorEvent;
            }
        },

        /**
         * Gets an event that is raised when an globe surface tile is loaded and ready to be rendered.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Event}
         */
        tileLoadedEvent : {
            get : function() {
                return this._tileLoadedEvent;
            }
        },

        /**
         * Gets an event that is raised when an imagery layer is added, shown, hidden, moved, or removed.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Event}
         */
        imageryLayersUpdatedEvent : {
            get : function() {
                return this._imageryLayersUpdatedEvent;
            }
        },

        /**
         * Gets or sets the terrain provider that describes the surface geometry.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {TerrainProvider}
         */
        terrainProvider : {
            get : function() {
                return this._terrainProvider;
            },
            set : function(terrainProvider) {
                if (this._terrainProvider === terrainProvider) {
                    return;
                }

                //>>includeStart('debug', pragmas.debug);
                if (!defined(terrainProvider)) {
                    throw new DeveloperError('terrainProvider is required.');
                }
                //>>includeEnd('debug');

                this._terrainProvider = terrainProvider;

                if (defined(this._quadtree)) {
                    this._quadtree.invalidateAllTiles();
                }
            }
        },
        /**
         * The {@link ClippingPlaneCollection} used to selectively disable rendering the tileset.
         *
         * @type {ClippingPlaneCollection}
         *
         * @private
         */
        clippingPlanes : {
            get : function() {
                return this._clippingPlanes;
            },
            set : function(value) {
                ClippingPlaneCollection.setOwner(value, this, '_clippingPlanes');
            }
        }
    });

    function sortTileImageryByLayerIndex(a, b) {
        var aImagery = a.loadingImagery;
        if (!defined(aImagery)) {
            aImagery = a.readyImagery;
        }

        var bImagery = b.loadingImagery;
        if (!defined(bImagery)) {
            bImagery = b.readyImagery;
        }

        return aImagery.imageryLayer._layerIndex - bImagery.imageryLayer._layerIndex;
    }

     /**
     * Make updates to the tile provider that are not involved in rendering. Called before the render update cycle.
     */
    GlobeSurfaceTileProvider.prototype.update = function(frameState) {
        // update collection: imagery indices, base layers, raise layer show/hide event
        this._imageryLayers._update();
    };

    function freeVertexArray(vertexArray) {
        var indexBuffer = vertexArray.indexBuffer;
        vertexArray.destroy();

        if (!indexBuffer.isDestroyed() && defined(indexBuffer.referenceCount)) {
            --indexBuffer.referenceCount;
            if (indexBuffer.referenceCount === 0) {
                indexBuffer.destroy();
            }
        }
    }

    function updateCredits(surface, frameState) {
        var creditDisplay = frameState.creditDisplay;
        if (surface._terrainProvider.ready && defined(surface._terrainProvider.credit)) {
            creditDisplay.addCredit(surface._terrainProvider.credit);
        }

        var imageryLayers = surface._imageryLayers;
        for (var i = 0, len = imageryLayers.length; i < len; ++i) {
            var imageryProvider = imageryLayers.get(i).imageryProvider;
            if (imageryProvider.ready && defined(imageryProvider.credit)) {
                creditDisplay.addCredit(imageryProvider.credit);
            }
        }
    }

    /**
     * Called at the beginning of each render frame, before {@link QuadtreeTileProvider#showTileThisFrame}
     * @param {FrameState} frameState The frame state.
     */
    GlobeSurfaceTileProvider.prototype.initialize = function(frameState) {
        // update each layer for texture reprojection.
        this._imageryLayers.queueReprojectionCommands(frameState);

        if (this._layerOrderChanged) {
            this._layerOrderChanged = false;

            // Sort the TileImagery instances in each tile by the layer index.
            this._quadtree.forEachLoadedTile(function(tile) {
                tile.data.imagery.sort(sortTileImageryByLayerIndex);
            });
        }

        // Add credits for terrain and imagery providers.
        updateCredits(this, frameState);

        var vertexArraysToDestroy = this._vertexArraysToDestroy;
        var length = vertexArraysToDestroy.length;
        for (var j = 0; j < length; ++j) {
            freeVertexArray(vertexArraysToDestroy[j]);
        }
        vertexArraysToDestroy.length = 0;
    };

    /**
     * Called at the beginning of the update cycle for each render frame, before {@link QuadtreeTileProvider#showTileThisFrame}
     * or any other functions.
     *
     * @param {FrameState} frameState The frame state.
     */
    GlobeSurfaceTileProvider.prototype.beginUpdate = function(frameState) {
        var tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
        for (var i = 0, len = tilesToRenderByTextureCount.length; i < len; ++i) {
            var tiles = tilesToRenderByTextureCount[i];
            if (defined(tiles)) {
                tiles.length = 0;
            }
        }
        // update clipping planes
        var clippingPlanes = this._clippingPlanes;
        if (defined(clippingPlanes) && clippingPlanes.enabled) {
            clippingPlanes.update(frameState);
        }
        this._usedDrawCommands = 0;
    };

    /**
     * Called at the end of the update cycle for each render frame, after {@link QuadtreeTileProvider#showTileThisFrame}
     * and any other functions.
     *
     * @param {FrameState} frameState The frame state.
     */
    GlobeSurfaceTileProvider.prototype.endUpdate = function(frameState) {
        if (!defined(this._renderState)) {
            this._renderState = RenderState.fromCache({ // Write color and depth
                cull : {
                    enabled : true
                },
                depthTest : {
                    enabled : true,
                    func : DepthFunction.LESS
                }
            });

            this._blendRenderState = RenderState.fromCache({ // Write color and depth
                cull : {
                    enabled : true
                },
                depthTest : {
                    enabled : true,
                    func : DepthFunction.LESS_OR_EQUAL
                },
                blending : BlendingState.ALPHA_BLEND
            });
        }

        // Add the tile render commands to the command list, sorted by texture count.
        var tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
        for (var textureCountIndex = 0, textureCountLength = tilesToRenderByTextureCount.length; textureCountIndex < textureCountLength; ++textureCountIndex) {
            var tilesToRender = tilesToRenderByTextureCount[textureCountIndex];
            if (!defined(tilesToRender)) {
                continue;
            }

            for (var tileIndex = 0, tileLength = tilesToRender.length; tileIndex < tileLength; ++tileIndex) {
                addDrawCommandsForTile(this, tilesToRender[tileIndex], frameState);
            }
        }
    };

    /**
     * Adds draw commands for tiles rendered in the previous frame for a pick pass.
     *
     * @param {FrameState} frameState The frame state.
     */
    GlobeSurfaceTileProvider.prototype.updateForPick = function(frameState) {
        // Add the tile pick commands from the tiles drawn last frame.
        var drawCommands = this._drawCommands;
        for (var i = 0, length = this._usedDrawCommands; i < length; ++i) {
            frameState.commandList.push(drawCommands[i]);
        }
    };

    /**
     * Cancels any imagery re-projections in the queue.
     */
    GlobeSurfaceTileProvider.prototype.cancelReprojections = function() {
        this._imageryLayers.cancelReprojections();
    };

    /**
     * Gets the maximum geometric error allowed in a tile at a given level, in meters.  This function should not be
     * called before {@link GlobeSurfaceTileProvider#ready} returns true.
     *
     * @param {Number} level The tile level for which to get the maximum geometric error.
     * @returns {Number} The maximum geometric error in meters.
     */
    GlobeSurfaceTileProvider.prototype.getLevelMaximumGeometricError = function(level) {
        return this._terrainProvider.getLevelMaximumGeometricError(level);
    };

    var stopLoad = false;

    /**
     * Loads, or continues loading, a given tile.  This function will continue to be called
     * until {@link QuadtreeTile#state} is no longer {@link QuadtreeTileLoadState#LOADING}.  This function should
     * not be called before {@link GlobeSurfaceTileProvider#ready} returns true.
     *
     * @param {FrameState} frameState The frame state.
     * @param {QuadtreeTile} tile The tile to load.
     *
     * @exception {DeveloperError} <code>loadTile</code> must not be called before the tile provider is ready.
     */
    GlobeSurfaceTileProvider.prototype.loadTile = function(frameState, tile) {
        if (stopLoad) {
            return;
        }
        GlobeSurfaceTile.processStateMachine(tile, frameState, this._terrainProvider, this._imageryLayers, this._vertexArraysToDestroy);
        var tileLoadedEvent = this._tileLoadedEvent;

        // TODO: creating a new function for every loaded tile every frame?!
        tile._loadedCallbacks['tileLoadedEvent'] = function (tile) {
            tileLoadedEvent.raiseEvent();
            return true;
        };
    };

    var boundingSphereScratch = new BoundingSphere();

    /**
     * Determines the visibility of a given tile.  The tile may be fully visible, partially visible, or not
     * visible at all.  Tiles that are renderable and are at least partially visible will be shown by a call
     * to {@link GlobeSurfaceTileProvider#showTileThisFrame}.
     *
     * @param {QuadtreeTile} tile The tile instance.
     * @param {FrameState} frameState The state information about the current frame.
     * @param {QuadtreeOccluders} occluders The objects that may occlude this tile.
     *
     * @returns {Visibility} The visibility of the tile.
     */
    GlobeSurfaceTileProvider.prototype.computeTileVisibility = function(tile, frameState, occluders) {
        var distance = this.computeDistanceToTile(tile, frameState);
        tile._distance = distance;

        if (frameState.fog.enabled) {
            if (CesiumMath.fog(distance, frameState.fog.density) >= 1.0) {
                // Tile is completely in fog so return that it is not visible.
                return Visibility.NONE;
            }
        }

        var surfaceTile = tile.data;
        var tileBoundingRegion = surfaceTile.tileBoundingRegion;

        if (surfaceTile.boundingVolumeSourceTile === undefined) {
            // We have no idea where this tile is, so let's just call it partially visible.
            return Visibility.PARTIAL;
        }

        var cullingVolume = frameState.cullingVolume;
        var boundingVolume = surfaceTile.orientedBoundingBox;

        if (frameState.mode !== SceneMode.SCENE3D) {
            boundingVolume = boundingSphereScratch;
            BoundingSphere.fromRectangleWithHeights2D(tile.rectangle, frameState.mapProjection, tileBoundingRegion.minimumHeight, tileBoundingRegion.maximumHeight, boundingVolume);
            Cartesian3.fromElements(boundingVolume.center.z, boundingVolume.center.x, boundingVolume.center.y, boundingVolume.center);

            if (frameState.mode === SceneMode.MORPHING && surfaceTile.mesh !== undefined) {
                boundingVolume = BoundingSphere.union(surfaceTile.mesh.boundingSphere3D, boundingVolume, boundingVolume);
            }
        }

        var clippingPlanes = this._clippingPlanes;
        if (defined(clippingPlanes) && clippingPlanes.enabled) {
            var planeIntersection = clippingPlanes.computeIntersectionWithBoundingVolume(boundingVolume);
            tile.isClipped = (planeIntersection !== Intersect.INSIDE);
            if (planeIntersection === Intersect.OUTSIDE) {
                return Visibility.NONE;
            }
        }

        var intersection = cullingVolume.computeVisibility(boundingVolume);
        if (intersection === Intersect.OUTSIDE) {
            return Visibility.NONE;
        }

        var ortho3D = frameState.mode === SceneMode.SCENE3D && frameState.camera.frustum instanceof OrthographicFrustum;
        if (frameState.mode === SceneMode.SCENE3D && !ortho3D && defined(occluders)) {
            var occludeePointInScaledSpace = surfaceTile.occludeePointInScaledSpace;
            if (!defined(occludeePointInScaledSpace)) {
                return intersection;
            }

            if (occluders.ellipsoid.isScaledSpacePointVisible(occludeePointInScaledSpace)) {
                return intersection;
            }

            return Visibility.NONE;
        }

        return intersection;
    };

    /**
     * Determines if the given tile can be refined
     * @param {QuadtreeTile} tile The tile to check.
     * @returns {boolean} True if the tile can be refined, false if it cannot.
     */
    GlobeSurfaceTileProvider.prototype.canRefine = function(tile) {
        // Only allow refinement it we know whether or not the children of this tile exist.
        // For a tileset with `availability`, we'll always be able to refine.
        // We can ask for availability of _any_ child tile because we only need to confirm
        // that we get a yes or no answer, it doesn't matter what the answer is.
        var childAvailable = tile.data.isChildAvailable(this.terrainProvider, tile, 0, 0);
        return childAvailable !== undefined;
    };

    var tileDirectionScratch = new Cartesian3();

    /**
     * Determines the priority for loading this tile. Lower priority values load sooner.
     * @param {QuatreeTile} tile The tile.
     * @param {FrameState} frameState The frame state.
     * @returns {Number} The load priority value.
     */
    GlobeSurfaceTileProvider.prototype.computeTileLoadPriority = function(tile, frameState) {
        var surfaceTile = tile.data;
        if (surfaceTile === undefined) {
            return 0.0;
        }

        var obb = surfaceTile.orientedBoundingBox;
        if (obb === undefined) {
            return 0.0;
        }

        var cameraPosition = frameState.camera.positionWC;
        var cameraDirection = frameState.camera.directionWC;
        var tileDirection = Cartesian3.normalize(Cartesian3.subtract(obb.center, cameraPosition, tileDirectionScratch), tileDirectionScratch);
        return (1.0 - Cartesian3.dot(tileDirection, cameraDirection)) * tile._distance;
    };

    var modifiedModelViewScratch = new Matrix4();
    var modifiedModelViewProjectionScratch = new Matrix4();
    var tileRectangleScratch = new Cartesian4();
    var rtcScratch = new Cartesian3();
    var centerEyeScratch = new Cartesian3();
    var southwestScratch = new Cartesian3();
    var northeastScratch = new Cartesian3();

    /**
     * Shows a specified tile in this frame.  The provider can cause the tile to be shown by adding
     * render commands to the commandList, or use any other method as appropriate.  The tile is not
     * expected to be visible next frame as well, unless this method is called next frame, too.
     *
     * @param {QuadtreeTile} tile The tile instance.
     * @param {FrameState} frameState The state information of the current rendering frame.
     * @param {QuadtreeTile} [nearestRenderableTile] The nearest ancestor tile that is renderable.
     */
    GlobeSurfaceTileProvider.prototype.showTileThisFrame = function(tile, frameState, nearestRenderableTile) {
        var readyTextureCount = 0;
        var tileImageryCollection = tile.data.imagery;
        for (var i = 0, len = tileImageryCollection.length; i < len; ++i) {
            var tileImagery = tileImageryCollection[i];
            if (defined(tileImagery.readyImagery) && tileImagery.readyImagery.imageryLayer.alpha !== 0.0) {
                ++readyTextureCount;
            }
        }

        var tileSet = this._tilesToRenderByTextureCount[readyTextureCount];
        if (!defined(tileSet)) {
            tileSet = [];
            this._tilesToRenderByTextureCount[readyTextureCount] = tileSet;
        }

        tileSet.push(tile);

        var surfaceTile = tile.data;
        if (nearestRenderableTile !== undefined && nearestRenderableTile !== tile) {
            surfaceTile.renderableTile = nearestRenderableTile;

            // The renderable tile may have previously deferred to an ancestor.
            // But we know it's renderable now, so mark it as such.
            nearestRenderableTile.data.renderableTile = undefined;

            var myRectangle = tile.rectangle;
            var ancestorRectangle = nearestRenderableTile.rectangle;
            var ancestorSubset = surfaceTile.renderableTileSubset;

            ancestorSubset.x = (myRectangle.west - ancestorRectangle.west) / (ancestorRectangle.east - ancestorRectangle.west);
            ancestorSubset.y = (myRectangle.south - ancestorRectangle.south) / (ancestorRectangle.north - ancestorRectangle.south);
            ancestorSubset.z = (myRectangle.east - ancestorRectangle.west) / (ancestorRectangle.east - ancestorRectangle.west);
            ancestorSubset.w = (myRectangle.north - ancestorRectangle.south) / (ancestorRectangle.north - ancestorRectangle.south);
        } else {
            surfaceTile.renderableTile = undefined;
        }

        var debug = this._debug;
        ++debug.tilesRendered;
        debug.texturesRendered += readyTextureCount;
    };

    var cornerPositionsScratch = [new Cartesian3(), new Cartesian3(), new Cartesian3(), new Cartesian3()];

    function computeOccludeePoint(tileProvider, center, rectangle, height, result) {
        var ellipsoidalOccluder = tileProvider.quadtree._occluders.ellipsoid;
        var ellipsoid = ellipsoidalOccluder.ellipsoid;

        var cornerPositions = cornerPositionsScratch;
        Cartesian3.fromRadians(rectangle.west, rectangle.south, height, ellipsoid, cornerPositions[0]);
        Cartesian3.fromRadians(rectangle.east, rectangle.south, height, ellipsoid, cornerPositions[1]);
        Cartesian3.fromRadians(rectangle.west, rectangle.north, height, ellipsoid, cornerPositions[2]);
        Cartesian3.fromRadians(rectangle.east, rectangle.north, height, ellipsoid, cornerPositions[3]);

        return ellipsoidalOccluder.computeHorizonCullingPoint(center, cornerPositions, result);
}

    /**
     * Gets the distance from the camera to the closest point on the tile.  This is used for level-of-detail selection.
     *
     * @param {QuadtreeTile} tile The tile instance.
     * @param {FrameState} frameState The state information of the current rendering frame.
     *
     * @returns {Number} The distance from the camera to the closest point on the tile, in meters.
     */
    GlobeSurfaceTileProvider.prototype.computeDistanceToTile = function(tile, frameState) {
        // The distance should be:
        // 1. the actual distance to the tight-fitting bounding volume, or
        // 2. a distance that is equal to or greater than the actual distance to the tight-fitting bounding volume.
        //
        // When we don't know the min/max heights for a tile, but we do know the min/max of an ancestor tile, we can
        // build a tight-fitting bounding volume horizontally, but not vertically. The min/max heights from the
        // ancestor will likely form a volume that is much bigger than it needs to be. This means that the volume may
        // be deemed to be much closer to the camera than it really is, causing us to select tiles that are too detailed.
        // Loading too-detailed tiles is super expensive, so we don't want to do that. We don't know where the child
        // tile really lies within the parent range of heights, but we _do_ know the child tile can't be any closer than
        // the ancestor height surface (min or max) that is _farthest away_ from the camera. So if we computed distance
        // based that conservative metric, we may end up loading tiles that are not detailed enough, but that's much
        // better (faster) than loading tiles that are too detailed.

        var heightSource = updateTileBoundingRegion(tile, this.terrainProvider, frameState);
        var surfaceTile = tile.data;
        var tileBoundingRegion = surfaceTile.tileBoundingRegion;

        if (heightSource === undefined) {
            // Can't find any min/max heights anywhere? Ok, let's just say the
            // tile is really far away so we'll load and render it rather than
            // refining.
            return 9999999999.0;
        } else if (surfaceTile.boundingVolumeSourceTile !== heightSource) {
            // Heights are from a new source tile, so update the bounding volume.
            surfaceTile.boundingVolumeSourceTile = heightSource;
            surfaceTile.orientedBoundingBox = OrientedBoundingBox.fromRectangle(
                tile.rectangle,
                tileBoundingRegion.minimumHeight,
                tileBoundingRegion.maximumHeight,
                tile.tilingScheme.ellipsoid,
                surfaceTile.orientedBoundingBox);

            surfaceTile.occludeePointInScaledSpace = computeOccludeePoint(this, surfaceTile.orientedBoundingBox.center, tile.rectangle, tileBoundingRegion.maximumHeight, surfaceTile.occludeePointInScaledSpace);
        }

        var min = tileBoundingRegion.minimumHeight;
        var max = tileBoundingRegion.maximumHeight;

        if (surfaceTile.boundingVolumeSourceTile !== tile) {
            var cameraHeight = frameState.camera.positionCartographic.height;
            var distanceToMin = Math.abs(cameraHeight - min);
            var distanceToMax = Math.abs(cameraHeight - max);
            if (distanceToMin > distanceToMax) {
                tileBoundingRegion.minimumHeight = min;
                tileBoundingRegion.maximumHeight = min;
            } else {
                tileBoundingRegion.minimumHeight = max;
                tileBoundingRegion.maximumHeight = max;
            }
        }

        var result = tileBoundingRegion.distanceToCamera(frameState);

        tileBoundingRegion.minimumHeight = min;
        tileBoundingRegion.maximumHeight = max;

        return result;
    };

    function updateTileBoundingRegion(tile, terrainProvider, frameState) {
        var surfaceTile = tile.data;
        if (surfaceTile === undefined) {
            surfaceTile = tile.data = new GlobeSurfaceTile();
        }

        if (surfaceTile.tileBoundingRegion === undefined) {
            surfaceTile.tileBoundingRegion = new TileBoundingRegion({
                computeBoundingVolumes : false,
                rectangle : tile.rectangle,
                ellipsoid : tile.tilingScheme.ellipsoid,
                minimumHeight : 0.0,
                maximumHeight : 0.0
            });
        }

        var terrainData = surfaceTile.terrainData;
        var mesh = surfaceTile.mesh;
        var tileBoundingRegion = surfaceTile.tileBoundingRegion;

        if (mesh !== undefined && mesh.minimumHeight !== undefined && mesh.maximumHeight !== undefined) {
            // We have tight-fitting min/max heights from the mesh.
            tileBoundingRegion.minimumHeight = mesh.minimumHeight;
            tileBoundingRegion.maximumHeight = mesh.maximumHeight;
            return tile;
        }

        if (terrainData !== undefined && terrainData._minimumHeight !== undefined && terrainData._maximumHeight !== undefined) {
            // We have tight-fitting min/max heights from the terrain data.
            tileBoundingRegion.minimumHeight = terrainData._minimumHeight * frameState.terrainExaggeration;
            tileBoundingRegion.maximumHeight = terrainData._maximumHeight * frameState.terrainExaggeration;
            return tile;
        }

        var bvh = surfaceTile.getBvh(tile, terrainProvider.terrainProvider);
        if (bvh !== undefined && bvh[0] === bvh[0] && bvh[1] === bvh[1]) {
            // Have a BVH that covers this tile and the heights are not NaN.
            tileBoundingRegion.minimumHeight = bvh[0] * frameState.terrainExaggeration;
            tileBoundingRegion.maximumHeight = bvh[1] * frameState.terrainExaggeration;
            return tile;
        }

        // No accurate BVH data available, so we're stuck with min/max heights from an ancestor tile.
        tileBoundingRegion.minimumHeight = Number.NaN;
        tileBoundingRegion.maximumHeight = Number.NaN;

        var ancestor = tile.parent;
        while (ancestor !== undefined) {
            var ancestorSurfaceTile = ancestor.data;
            if (ancestorSurfaceTile !== undefined) {
                var ancestorMesh = ancestorSurfaceTile.mesh;
                if (ancestorMesh !== undefined && ancestorMesh.minimumHeight !== undefined && ancestorMesh.maximumHeight !== undefined) {
                    tileBoundingRegion.minimumHeight = ancestorMesh.minimumHeight;
                    tileBoundingRegion.maximumHeight = ancestorMesh.maximumHeight;
                    return ancestor;
                }

                var ancestorTerrainData = ancestorSurfaceTile.terrainData;
                if (ancestorTerrainData !== undefined && ancestorTerrainData._minimumHeight !== undefined && ancestorTerrainData._maximumHeight !== undefined) {
                    tileBoundingRegion.minimumHeight = ancestorTerrainData._minimumHeight * frameState.terrainExaggeration;
                    tileBoundingRegion.maximumHeight = ancestorTerrainData._maximumHeight * frameState.terrainExaggeration;
                    return ancestor;
                }

                var ancestorBvh = ancestorSurfaceTile._bvh;
                if (ancestorBvh !== undefined && ancestorBvh[0] === ancestorBvh[0] && ancestorBvh[1] === ancestorBvh[1]) {
                    tileBoundingRegion.minimumHeight = ancestorBvh[0] * frameState.terrainExaggeration;
                    tileBoundingRegion.maximumHeight = ancestorBvh[1] * frameState.terrainExaggeration;
                    return ancestor;
                }
            }
            ancestor = ancestor.parent;
        }

        return undefined;
    }

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @returns {Boolean} True if this object was destroyed; otherwise, false.
     *
     * @see GlobeSurfaceTileProvider#destroy
     */
    GlobeSurfaceTileProvider.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     *
     * @example
     * provider = provider && provider();
     *
     * @see GlobeSurfaceTileProvider#isDestroyed
     */
    GlobeSurfaceTileProvider.prototype.destroy = function() {
        this._tileProvider = this._tileProvider && this._tileProvider.destroy();
        this._clippingPlanes = this._clippingPlanes && this._clippingPlanes.destroy();

        return destroyObject(this);
    };

    function getTileReadyCallback(tileImageriesToFree, layer, terrainProvider) {
        return function(tile) {
            var tileImagery;
            var imagery;
            var startIndex = -1;
            var tileImageryCollection = tile.data.imagery;
            var length = tileImageryCollection.length;
            var i;
            for (i = 0; i < length; ++i) {
                tileImagery = tileImageryCollection[i];
                imagery = defaultValue(tileImagery.readyImagery, tileImagery.loadingImagery);
                if (imagery.imageryLayer === layer) {
                    startIndex = i;
                    break;
                }
            }

            if (startIndex !== -1) {
                var endIndex = startIndex + tileImageriesToFree;
                tileImagery = tileImageryCollection[endIndex];
                imagery = defined(tileImagery) ? defaultValue(tileImagery.readyImagery, tileImagery.loadingImagery) : undefined;
                if (!defined(imagery) || imagery.imageryLayer !== layer) {
                    // Return false to keep the callback if we have to wait on the skeletons
                    // Return true to remove the callback if something went wrong
                    return !(layer._createTileImagerySkeletons(tile, terrainProvider, endIndex));
                }

                for (i = startIndex; i < endIndex; ++i) {
                    tileImageryCollection[i].freeResources();
                }

                tileImageryCollection.splice(startIndex, tileImageriesToFree);
            }

            return true; // Everything is done, so remove the callback
        };
    }

    GlobeSurfaceTileProvider.prototype._onLayerAdded = function(layer, index) {
        if (layer.show) {
            var terrainProvider = this._terrainProvider;

            var that = this;
            var imageryProvider = layer.imageryProvider;
            var tileImageryUpdatedEvent = this._imageryLayersUpdatedEvent;
            imageryProvider._reload = function() {
                // Clear the layer's cache
                layer._imageryCache = {};

                that._quadtree.forEachLoadedTile(function(tile) {
                    // If this layer is still waiting to for the loaded callback, just return
                    if (defined(tile._loadedCallbacks[layer._layerIndex])) {
                        return;
                    }

                    var i;

                    // Figure out how many TileImageries we will need to remove and where to insert new ones
                    var tileImageryCollection = tile.data.imagery;
                    var length = tileImageryCollection.length;
                    var startIndex = -1;
                    var tileImageriesToFree = 0;
                    for (i = 0; i < length; ++i) {
                        var tileImagery = tileImageryCollection[i];
                        var imagery = defaultValue(tileImagery.readyImagery, tileImagery.loadingImagery);
                        if (imagery.imageryLayer === layer) {
                            if (startIndex === -1) {
                                startIndex = i;
                            }

                            ++tileImageriesToFree;
                        } else if (startIndex !== -1) {
                            // iterated past the section of TileImageries belonging to this layer, no need to continue.
                            break;
                        }
                    }

                    if (startIndex === -1) {
                        return;
                    }

                    // Insert immediately after existing TileImageries
                    var insertionPoint = startIndex + tileImageriesToFree;

                    // Create new TileImageries for all loaded tiles
                    if (layer._createTileImagerySkeletons(tile, terrainProvider, insertionPoint)) {
                        // Add callback to remove old TileImageries when the new TileImageries are ready
                        tile._loadedCallbacks[layer._layerIndex] = getTileReadyCallback(tileImageriesToFree, layer, terrainProvider);

                        tile.state = QuadtreeTileLoadState.LOADING;
                    }
                });
            };

            // create TileImageries for this layer for all previously loaded tiles
            this._quadtree.forEachLoadedTile(function(tile) {
                if (layer._createTileImagerySkeletons(tile, terrainProvider)) {
                    tile.state = QuadtreeTileLoadState.LOADING;
                }
            });

            this._layerOrderChanged = true;
            tileImageryUpdatedEvent.raiseEvent();
        }
    };

    GlobeSurfaceTileProvider.prototype._onLayerRemoved = function(layer, index) {
        // destroy TileImagerys for this layer for all previously loaded tiles
        this._quadtree.forEachLoadedTile(function(tile) {
            var tileImageryCollection = tile.data.imagery;

            var startIndex = -1;
            var numDestroyed = 0;
            for (var i = 0, len = tileImageryCollection.length; i < len; ++i) {
                var tileImagery = tileImageryCollection[i];
                var imagery = tileImagery.loadingImagery;
                if (!defined(imagery)) {
                    imagery = tileImagery.readyImagery;
                }
                if (imagery.imageryLayer === layer) {
                    if (startIndex === -1) {
                        startIndex = i;
                    }

                    tileImagery.freeResources();
                    ++numDestroyed;
                } else if (startIndex !== -1) {
                    // iterated past the section of TileImagerys belonging to this layer, no need to continue.
                    break;
                }
            }

            if (startIndex !== -1) {
                tileImageryCollection.splice(startIndex, numDestroyed);
            }
        });

        if (defined(layer.imageryProvider)) {
            layer.imageryProvider._reload = undefined;
        }

        this._imageryLayersUpdatedEvent.raiseEvent();
    };

    GlobeSurfaceTileProvider.prototype._onLayerMoved = function(layer, newIndex, oldIndex) {
        this._layerOrderChanged = true;
        this._imageryLayersUpdatedEvent.raiseEvent();
    };

    GlobeSurfaceTileProvider.prototype._onLayerShownOrHidden = function(layer, index, show) {
        if (show) {
            this._onLayerAdded(layer, index);
        } else {
            this._onLayerRemoved(layer, index);
        }
    };

    var scratchClippingPlaneMatrix = new Matrix4();
    function createTileUniformMap(frameState, globeSurfaceTileProvider) {
        var uniformMap = {
            u_initialColor : function() {
                return this.properties.initialColor;
            },
            u_zoomedOutOceanSpecularIntensity : function() {
                return this.properties.zoomedOutOceanSpecularIntensity;
            },
            u_oceanNormalMap : function() {
                return this.properties.oceanNormalMap;
            },
            u_lightingFadeDistance : function() {
                return this.properties.lightingFadeDistance;
            },
            u_center3D : function() {
                return this.properties.center3D;
            },
            u_tileRectangle : function() {
                return this.properties.tileRectangle;
            },
            u_modifiedModelView : function() {
                var viewMatrix = frameState.context.uniformState.view;
                var centerEye = Matrix4.multiplyByPoint(viewMatrix, this.properties.rtc, centerEyeScratch);
                Matrix4.setTranslation(viewMatrix, centerEye, modifiedModelViewScratch);
                return modifiedModelViewScratch;
            },
            u_modifiedModelViewProjection : function() {
                var viewMatrix = frameState.context.uniformState.view;
                var projectionMatrix = frameState.context.uniformState.projection;
                var centerEye = Matrix4.multiplyByPoint(viewMatrix, this.properties.rtc, centerEyeScratch);
                Matrix4.setTranslation(viewMatrix, centerEye, modifiedModelViewProjectionScratch);
                Matrix4.multiply(projectionMatrix, modifiedModelViewProjectionScratch, modifiedModelViewProjectionScratch);
                return modifiedModelViewProjectionScratch;
            },
            u_dayTextures : function() {
                return this.properties.dayTextures;
            },
            u_dayTextureTranslationAndScale : function() {
                return this.properties.dayTextureTranslationAndScale;
            },
            u_dayTextureTexCoordsRectangle : function() {
                return this.properties.dayTextureTexCoordsRectangle;
            },
            u_dayTextureUseWebMercatorT : function() {
                return this.properties.dayTextureUseWebMercatorT;
            },
            u_dayTextureAlpha : function() {
                return this.properties.dayTextureAlpha;
            },
            u_dayTextureBrightness : function() {
                return this.properties.dayTextureBrightness;
            },
            u_dayTextureContrast : function() {
                return this.properties.dayTextureContrast;
            },
            u_dayTextureHue : function() {
                return this.properties.dayTextureHue;
            },
            u_dayTextureSaturation : function() {
                return this.properties.dayTextureSaturation;
            },
            u_dayTextureOneOverGamma : function() {
                return this.properties.dayTextureOneOverGamma;
            },
            u_dayIntensity : function() {
                return this.properties.dayIntensity;
            },
            u_southAndNorthLatitude : function() {
                return this.properties.southAndNorthLatitude;
            },
            u_southMercatorYAndOneOverHeight : function() {
                return this.properties.southMercatorYAndOneOverHeight;
            },
            u_waterMask : function() {
                return this.properties.waterMask;
            },
            u_waterMaskTranslationAndScale : function() {
                return this.properties.waterMaskTranslationAndScale;
            },
            u_minMaxHeight : function() {
                return this.properties.minMaxHeight;
            },
            u_scaleAndBias : function() {
                return this.properties.scaleAndBias;
            },
            u_dayTextureSplit : function() {
                return this.properties.dayTextureSplit;
            },
            u_clippingPlanes : function() {
                var clippingPlanes = globeSurfaceTileProvider._clippingPlanes;
                if (defined(clippingPlanes) && defined(clippingPlanes.texture)) {
                    // Check in case clippingPlanes hasn't been updated yet.
                    return clippingPlanes.texture;
                }
                return frameState.context.defaultTexture;
            },
            u_clippingPlanesMatrix : function() {
                var clippingPlanes = globeSurfaceTileProvider._clippingPlanes;
                return defined(clippingPlanes) ? Matrix4.multiply(frameState.context.uniformState.view, clippingPlanes.modelMatrix, scratchClippingPlaneMatrix) : Matrix4.IDENTITY;
            },
            u_clippingPlanesEdgeStyle : function() {
                var style = this.properties.clippingPlanesEdgeColor;
                style.alpha = this.properties.clippingPlanesEdgeWidth;
                return style;
            },
            u_minimumBrightness : function() {
                return frameState.fog.minimumBrightness;
            },
            u_textureCoordinateSubset : function() {
                return this.properties.textureCoordinateSubset;
            },

            // make a separate object so that changes to the properties are seen on
            // derived commands that combine another uniform map with this one.
            properties : {
                initialColor : new Cartesian4(0.0, 0.0, 0.5, 1.0),
                zoomedOutOceanSpecularIntensity : 0.5,
                oceanNormalMap : undefined,
                lightingFadeDistance : new Cartesian2(6500000.0, 9000000.0),

                center3D : undefined,
                rtc : new Cartesian3(),
                modifiedModelView : new Matrix4(),
                tileRectangle : new Cartesian4(),

                dayTextures : [],
                dayTextureTranslationAndScale : [],
                dayTextureTexCoordsRectangle : [],
                dayTextureUseWebMercatorT : [],
                dayTextureAlpha : [],
                dayTextureBrightness : [],
                dayTextureContrast : [],
                dayTextureHue : [],
                dayTextureSaturation : [],
                dayTextureOneOverGamma : [],
                dayTextureSplit : [],
                dayIntensity : 0.0,

                southAndNorthLatitude : new Cartesian2(),
                southMercatorYAndOneOverHeight : new Cartesian2(),

                waterMask : undefined,
                waterMaskTranslationAndScale : new Cartesian4(),

                minMaxHeight : new Cartesian2(),
                scaleAndBias : new Matrix4(),
                clippingPlanesEdgeColor : Color.clone(Color.WHITE),
                clippingPlanesEdgeWidth : 0.0,
                textureCoordinateSubset : new Cartesian4()
            }
        };

        return uniformMap;
    }

    function createWireframeVertexArrayIfNecessary(context, provider, tile) {
        var surfaceTile = tile.data;

        var mesh;
        var vertexArray;

        if (surfaceTile.vertexArray !== undefined) {
            mesh = surfaceTile.mesh;
            vertexArray = surfaceTile.vertexArray;
        } else if (surfaceTile.fillVertexArray !== undefined) {
            mesh = surfaceTile.fillMesh;
            vertexArray = surfaceTile.fillVertexArray;
        }

        if (!defined(mesh) || !defined(vertexArray)) {
            return;
        }

        if (defined(surfaceTile.wireframeVertexArray)) {
            if (surfaceTile.wireframeVertexArray.mesh === mesh) {
                return;
            }

            surfaceTile.wireframeVertexArray.destroy();
            surfaceTile.wireframeVertexArray = undefined;
        }

        surfaceTile.wireframeVertexArray = createWireframeVertexArray(context, vertexArray, mesh);
        surfaceTile.wireframeVertexArray.mesh = mesh;
    }

    /**
     * Creates a vertex array for wireframe rendering of a terrain tile.
     *
     * @private
     *
     * @param {Context} context The context in which to create the vertex array.
     * @param {VertexArray} vertexArray The existing, non-wireframe vertex array.  The new vertex array
     *                      will share vertex buffers with this existing one.
     * @param {TerrainMesh} terrainMesh The terrain mesh containing non-wireframe indices.
     * @returns {VertexArray} The vertex array for wireframe rendering.
     */
    function createWireframeVertexArray(context, vertexArray, terrainMesh) {
        var geometry = {
            indices : terrainMesh.indices,
            primitiveType : PrimitiveType.TRIANGLES
        };

        GeometryPipeline.toWireframe(geometry);

        var wireframeIndices = geometry.indices;
        var wireframeIndexBuffer = Buffer.createIndexBuffer({
            context : context,
            typedArray : wireframeIndices,
            usage : BufferUsage.STATIC_DRAW,
            indexDatatype : IndexDatatype.UNSIGNED_SHORT
        });
        return new VertexArray({
            context : context,
            attributes : vertexArray._attributes,
            indexBuffer : wireframeIndexBuffer
        });
    }

    var getDebugOrientedBoundingBox;
    var getDebugBoundingSphere;
    var debugDestroyPrimitive;

    (function() {
        var instanceOBB = new GeometryInstance({
            geometry : BoxOutlineGeometry.fromDimensions({dimensions : new Cartesian3(2.0, 2.0, 2.0)})
        });
        var instanceSphere = new GeometryInstance({
            geometry : new SphereOutlineGeometry({radius : 1.0})
        });
        var modelMatrix = new Matrix4();
        var previousVolume;
        var primitive;

        function createDebugPrimitive(instance) {
            return new Primitive({
                geometryInstances : instance,
                appearance : new PerInstanceColorAppearance({
                    translucent : false,
                    flat : true
                }),
                asynchronous : false
            });
        }

        getDebugOrientedBoundingBox = function(obb, color) {
            if (obb === previousVolume) {
                return primitive;
            }
            debugDestroyPrimitive();

            previousVolume = obb;
            modelMatrix = Matrix4.fromRotationTranslation(obb.halfAxes, obb.center, modelMatrix);

            instanceOBB.modelMatrix = modelMatrix;
            instanceOBB.attributes.color = ColorGeometryInstanceAttribute.fromColor(color);

            primitive = createDebugPrimitive(instanceOBB);
            return primitive;
        };

        getDebugBoundingSphere = function(sphere, color) {
            if (sphere === previousVolume) {
                return primitive;
            }
            debugDestroyPrimitive();

            previousVolume = sphere;
            modelMatrix = Matrix4.fromTranslation(sphere.center, modelMatrix);
            modelMatrix = Matrix4.multiplyByUniformScale(modelMatrix, sphere.radius, modelMatrix);

            instanceSphere.modelMatrix = modelMatrix;
            instanceSphere.attributes.color = ColorGeometryInstanceAttribute.fromColor(color);

            primitive = createDebugPrimitive(instanceSphere);
            return primitive;
        };

        debugDestroyPrimitive = function() {
            if (defined(primitive)) {
                primitive.destroy();
                primitive = undefined;
                previousVolume = undefined;
            }
        };
    })();

    function findRenderedTiles(startTile, currentFrameNumber, edge, downOnly) {
        if (startTile === undefined) {
            // There are no tiles North or South of the poles.
            return [];
        }

        if (startTile._lastSelectionResultFrame !== currentFrameNumber || startTile._lastSelectionResult === TileSelectionResult.KICKED) {
            if (downOnly) {
                return [];
            }

            // This wasn't visited or was visited and then kicked, so walk up to find the closest ancestor that was rendered.
            var tile = startTile.parent;
            while (tile && tile._lastSelectionResultFrame !== currentFrameNumber) {
                tile = tile.parent;
            }

            if (tile !== undefined && tile._lastSelectionResult === TileSelectionResult.RENDERED) {
                return [tile];
            }

            // No ancestor was rendered.
            return [];
        }

        if (startTile._lastSelectionResult === TileSelectionResult.RENDERED) {
            return [startTile];
        }

        if (startTile._lastSelectionResult === TileSelectionResult.CULLED) {
            return [];
        }

        // This tile was refined, so find rendered children, if any.
        // Return the tiles in clockwise order.
        switch (edge) {
            case TileEdge.WEST:
                return findRenderedTiles(startTile.southwestChild, currentFrameNumber, edge, true).concat(findRenderedTiles(startTile.northwestChild, currentFrameNumber, edge, true));
            case TileEdge.EAST:
                return findRenderedTiles(startTile.northeastChild, currentFrameNumber, edge, true).concat(findRenderedTiles(startTile.southeastChild, currentFrameNumber, edge, true));
            case TileEdge.SOUTH:
                return findRenderedTiles(startTile.southeastChild, currentFrameNumber, edge, true).concat(findRenderedTiles(startTile.southwestChild, currentFrameNumber, edge, true));
            case TileEdge.NORTH:
                return findRenderedTiles(startTile.northwestChild, currentFrameNumber, edge, true).concat(findRenderedTiles(startTile.northeastChild, currentFrameNumber, edge, true));
            default:
                throw new DeveloperError('Invalid edge');
        }
    }

    function getEdgeVertices(tile, startingTile, currentFrameNumber, tileEdge, result) {
        var ellipsoid = tile.tilingScheme.ellipsoid;
        var edgeTiles = findRenderedTiles(startingTile, currentFrameNumber, tileEdge);

        tile.edgeTiles = tile.edgeTiles || [];
        tile.edgeTiles[tileEdge] = edgeTiles;

        result.clear();

        for (var i = 0; i < edgeTiles.length; ++i) {
            var edgeTile = edgeTiles[i];
            var surfaceTile = edgeTile.data;
            if (surfaceTile === undefined) {
                continue;
            }

            var mesh = surfaceTile.fillMesh;
            if (surfaceTile.mesh !== undefined && surfaceTile.vertexArray !== undefined) {
                mesh = surfaceTile.mesh;
            }

            if (mesh !== undefined) {
                var beforeLength = result.vertices.length;
                mesh.getEdgeVertices(tileEdge, edgeTile.rectangle, tile.rectangle, ellipsoid, result);
                var afterLength = result.vertices.length;
                var numberOfVertices = afterLength - beforeLength;
                if (surfaceTile.mesh === undefined && numberOfVertices > 27) {
                    console.log(`${numberOfVertices} from L${edgeTile.level}X${edgeTile.x}Y${edgeTile.y}`);
                }
            }
        }

        return result;
    }

    var cartographicScratch = new Cartographic();
    var cartesianScratch = new Cartesian3();
    var normalScratch = new Cartesian3();
    var octEncodedNormalScratch = new Cartesian2();

    function addCornerVertexIfNecessary(ellipsoid, u, v, longitude, latitude, height, edgeDetails, previousEdgeDetails, hasVertexNormals, hasWebMercatorT, tileVertices) {
        var vertices = edgeDetails.vertices;

        if (u === vertices[4] && v === vertices[5]) {
            // First vertex is a corner vertex, as expected.
            return;
        }

        // Can we use the last vertex of the previous edge as the corner vertex?
        var stride = 6 + (hasWebMercatorT ? 1 : 0) + (hasVertexNormals ? 2 : 0);
        var previousVertices = previousEdgeDetails.vertices;
        var lastVertexStart = previousVertices.length - stride;
        var lastU = previousVertices[lastVertexStart + 4];
        var lastV = previousVertices[lastVertexStart + 5];

        if (lastU === u && lastV === v) {
            for (var i = 0; i < stride; ++i) {
                tileVertices.push(previousVertices[lastVertexStart + i]);
            }
            return;
        }

        // Previous edge doesn't contain a suitable vertex either, so fabricate one.
        cartographicScratch.longitude = longitude;
        cartographicScratch.latitude = latitude;
        cartographicScratch.height = height;
        ellipsoid.cartographicToCartesian(cartographicScratch, cartesianScratch);
        tileVertices.push(cartesianScratch.x, cartesianScratch.y, cartesianScratch.z, height, u, v);

        if (hasWebMercatorT) {
            // Identical to v at 0.0 and 1.0.
            tileVertices.push(v);
        }

        if (hasVertexNormals) {
            ellipsoid.geodeticSurfaceNormalCartographic(cartographicScratch, normalScratch);
            AttributeCompression.octEncode(normalScratch, octEncodedNormalScratch);
            tileVertices.push(octEncodedNormalScratch.x, octEncodedNormalScratch.y);
            //tileVertices.push(AttributeCompression.octPackFloat(octEncodedNormalScratch));
        }
    }

    function addVerticesToFillTile(edgeDetails, stride, tileVertices) {
        var vertices = edgeDetails.vertices;

        // Copy all but the last vertex.
        var i;
        var u;
        var v;
        var lastU;
        var lastV;
        for (i = 0; i < vertices.length - stride; i += stride) {
            u = vertices[i + 4];
            v = vertices[i + 5];
            if (Math.abs(u - lastU) < CesiumMath.EPSILON4 && Math.abs(v - lastV) < CesiumMath.EPSILON4) {
                // Vertex is very close to the previous one, so skip it.
                continue;
            }

            var end = i + stride;
            for (var j = i; j < end; ++j) {
                tileVertices.push(vertices[j]);
            }

            lastU = u;
            lastV = v;
        }

        // Copy the last vertex too if it's _not_ a corner vertex.
        var lastVertexStart = i;
        u = vertices[lastVertexStart + 4];
        v = vertices[lastVertexStart + 5];

        if (lastVertexStart < vertices.length && ((u !== 0.0 && u !== 1.0) || (v !== 0.0 && v !== 1.0))) {
            if (Math.abs(u - lastU) < CesiumMath.EPSILON4 && Math.abs(v - lastV) < CesiumMath.EPSILON4) {
                // Overwrite the previous vertex because it's very close to the last one.
                tileVertices.length -= stride;
            }

            for (; i < vertices.length; ++i) {
                tileVertices.push(vertices[i]);
            }
        }
    }

    var westScratch = new TerrainTileEdgeDetails();
    var southScratch = new TerrainTileEdgeDetails();
    var eastScratch = new TerrainTileEdgeDetails();
    var northScratch = new TerrainTileEdgeDetails();
    var tileVerticesScratch = [];

    function createFillTile(tileProvider, tile, frameState) {
        //console.log('L' + tile.level + 'X' + tile.x + 'Y' + tile.y);
        var start = performance.now();

        var mesh;
        var typedArray;
        var indices;
        var surfaceTile = tile.data;
        // if (surfaceTile.mesh === undefined) {
            var quadtree = tileProvider._quadtree;
            var levelZeroTiles = quadtree._levelZeroTiles;
            var lastSelectionFrameNumber = quadtree._lastSelectionFrameNumber;

            var west = getEdgeVertices(tile, tile.findTileToWest(levelZeroTiles), lastSelectionFrameNumber, TileEdge.EAST, westScratch);
            var south = getEdgeVertices(tile, tile.findTileToSouth(levelZeroTiles), lastSelectionFrameNumber, TileEdge.NORTH, southScratch);
            var east = getEdgeVertices(tile, tile.findTileToEast(levelZeroTiles), lastSelectionFrameNumber, TileEdge.WEST, eastScratch);
            var north = getEdgeVertices(tile, tile.findTileToNorth(levelZeroTiles), lastSelectionFrameNumber, TileEdge.SOUTH, northScratch);

            var hasVertexNormals = tileProvider.terrainProvider.hasVertexNormals;
            var hasWebMercatorT = true; // TODO
            var stride = 6 + (hasWebMercatorT ? 1 : 0) + (hasVertexNormals ? 2 : 0);

            var minimumHeight = Number.MAX_VALUE;
            var maximumHeight = -Number.MAX_VALUE;
            var hasAnyVertices = false;

            if (west.vertices.length > 0) {
                minimumHeight = Math.min(minimumHeight, west.minimumHeight);
                maximumHeight = Math.max(maximumHeight, west.maximumHeight);
                hasAnyVertices = true;
            }

            if (south.vertices.length > 0) {
                minimumHeight = Math.min(minimumHeight, south.minimumHeight);
                maximumHeight = Math.max(maximumHeight, south.maximumHeight);
                hasAnyVertices = true;
            }

            if (east.vertices.length > 0) {
                minimumHeight = Math.min(minimumHeight, east.minimumHeight);
                maximumHeight = Math.max(maximumHeight, east.maximumHeight);
                hasAnyVertices = true;
            }

            if (north.vertices.length > 0) {
                minimumHeight = Math.min(minimumHeight, north.minimumHeight);
                maximumHeight = Math.max(maximumHeight, north.maximumHeight);
                hasAnyVertices = true;
            }

            if (!hasAnyVertices) {
                var tileBoundingRegion = surfaceTile.tileBoundingRegion;
                minimumHeight = tileBoundingRegion.minimumHeight;
                maximumHeight = tileBoundingRegion.maximumHeight;
            }

            var middleHeight = (minimumHeight + maximumHeight) * 0.5;

            var tileVertices = tileVerticesScratch;
            tileVertices.length = 0;

            var ellipsoid = tile.tilingScheme.ellipsoid;
            var rectangle = tile.rectangle;

            var northwestIndex = 0;
            addCornerVertexIfNecessary(ellipsoid, 0.0, 1.0, rectangle.west, rectangle.north, middleHeight, west, north, hasVertexNormals, hasWebMercatorT, tileVertices);
            addVerticesToFillTile(west, stride, tileVertices);
            var southwestIndex = tileVertices.length / stride;
            addCornerVertexIfNecessary(ellipsoid, 0.0, 0.0, rectangle.west, rectangle.south, middleHeight, south, west, hasVertexNormals, hasWebMercatorT, tileVertices);
            addVerticesToFillTile(south, stride, tileVertices);
            var southeastIndex = tileVertices.length / stride;
            addCornerVertexIfNecessary(ellipsoid, 1.0, 0.0, rectangle.east, rectangle.south, middleHeight, east, south, hasVertexNormals, hasWebMercatorT, tileVertices);
            addVerticesToFillTile(east, stride, tileVertices);
            var northeastIndex = tileVertices.length / stride;
            addCornerVertexIfNecessary(ellipsoid, 1.0, 1.0, rectangle.east, rectangle.north, middleHeight, north, east, hasVertexNormals, hasWebMercatorT, tileVertices);
            addVerticesToFillTile(north, stride, tileVertices);

            // Add a single vertex at the center of the tile.
            var obb = OrientedBoundingBox.fromRectangle(tile.rectangle, minimumHeight, maximumHeight, tile.tilingScheme.ellipsoid);
            var center = obb.center;

            ellipsoid.cartesianToCartographic(center, cartographicScratch);
            cartographicScratch.height = middleHeight;
            var centerVertexPosition = ellipsoid.cartographicToCartesian(cartographicScratch, cartesianScratch);

            tileVertices.push(centerVertexPosition.x, centerVertexPosition.y, centerVertexPosition.z, middleHeight);
            tileVertices.push((cartographicScratch.longitude - rectangle.west) / (rectangle.east - rectangle.west));
            tileVertices.push((cartographicScratch.latitude - rectangle.south) / (rectangle.north - rectangle.south));

            if (hasWebMercatorT) {
                var southMercatorY = WebMercatorProjection.geodeticLatitudeToMercatorAngle(rectangle.south);
                var oneOverMercatorHeight = 1.0 / (WebMercatorProjection.geodeticLatitudeToMercatorAngle(rectangle.north) - southMercatorY);
                tileVertices.push((WebMercatorProjection.geodeticLatitudeToMercatorAngle(cartographicScratch.latitude) - southMercatorY) * oneOverMercatorHeight);
            }

            if (hasVertexNormals) {
                ellipsoid.geodeticSurfaceNormalCartographic(cartographicScratch, normalScratch);
                AttributeCompression.octEncode(normalScratch, octEncodedNormalScratch);
                tileVertices.push(octEncodedNormalScratch.x, octEncodedNormalScratch.y);
            }

            var vertexCount = tileVertices.length / stride;
            indices = new Uint16Array((vertexCount - 1) * 3); // one triangle per edge vertex
            var centerIndex = vertexCount - 1;

            var indexOut = 0;
            var i;
            for (i = 0; i < vertexCount - 2; ++i) {
                indices[indexOut++] = centerIndex;
                indices[indexOut++] = i;
                indices[indexOut++] = i + 1;
            }

            indices[indexOut++] = centerIndex;
            indices[indexOut++] = i;
            indices[indexOut++] = 0;

            var westIndicesSouthToNorth = [];
            for (i = southwestIndex; i >= northwestIndex; --i) {
                westIndicesSouthToNorth.push(i);
            }

            var southIndicesEastToWest = [];
            for (i = southeastIndex; i >= southwestIndex; --i) {
                southIndicesEastToWest.push(i);
            }

            var eastIndicesNorthToSouth = [];
            for (i = northeastIndex; i >= southeastIndex; --i) {
                eastIndicesNorthToSouth.push(i);
            }

            var northIndicesWestToEast = [];
            northIndicesWestToEast.push(0);
            for (i = centerIndex - 1; i >= northeastIndex; --i) {
                northIndicesWestToEast.push(i);
            }

            var packedStride = hasVertexNormals ? stride - 1 : stride; // normal is packed into 1 float
            typedArray = new Float32Array(vertexCount * packedStride);

            for (i = 0; i < vertexCount; ++i) {
                var read = i * stride;
                var write = i * packedStride;
                typedArray[write++] = tileVertices[read++] - center.x;
                typedArray[write++] = tileVertices[read++] - center.y;
                typedArray[write++] = tileVertices[read++] - center.z;
                typedArray[write++] = tileVertices[read++];
                typedArray[write++] = tileVertices[read++];
                typedArray[write++] = tileVertices[read++];

                if (hasWebMercatorT) {
                    typedArray[write++] = tileVertices[read++];
                }

                if (hasVertexNormals) {
                    typedArray[write++] = AttributeCompression.octPackFloat(Cartesian2.fromElements(tileVertices[read++], tileVertices[read++], octEncodedNormalScratch));
                }
            }

            var encoding = new TerrainEncoding(undefined, minimumHeight, maximumHeight, undefined, hasVertexNormals, hasWebMercatorT);
            encoding.center = center;

            mesh = new TerrainMesh(
                obb.center,
                typedArray,
                indices,
                minimumHeight,
                maximumHeight,
                BoundingSphere.fromOrientedBoundingBox(obb),
                computeOccludeePoint(tileProvider, center, rectangle, maximumHeight),
                encoding.getStride(),
                obb,
                encoding,
                frameState.terrainExaggeration,
                westIndicesSouthToNorth,
                southIndicesEastToWest,
                eastIndicesNorthToSouth,
                northIndicesWestToEast
            );

            surfaceTile.fillMesh = mesh;
        // } else {
        //     mesh = surfaceTile.mesh;
        //     typedArray = mesh.vertices;
        //     indices = mesh.indices;
        // }

        var context = frameState.context;

        if (surfaceTile.fillVertexArray !== undefined) {
            surfaceTile.fillVertexArray.destroy();
            surfaceTile.fillVertexArray = undefined;
        }

        var buffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : typedArray,
            usage : BufferUsage.STATIC_DRAW
        });
        var attributes = mesh.encoding.getAttributes(buffer);

        var indexDatatype = (indices.BYTES_PER_ELEMENT === 2) ?  IndexDatatype.UNSIGNED_SHORT : IndexDatatype.UNSIGNED_INT;
        var indexBuffer = Buffer.createIndexBuffer({
            context : context,
            typedArray : mesh.indices,
            usage : BufferUsage.STATIC_DRAW,
            indexDatatype : indexDatatype
        });

        surfaceTile.fillVertexArray = new VertexArray({
            context : context,
            attributes : attributes,
            indexBuffer : indexBuffer
        });

        var tileImageryCollection = surfaceTile.imagery;

        var len;
        if (tileImageryCollection.length === 0) {
            var imageryLayerCollection = tileProvider._imageryLayers;
            var terrainProvider = tileProvider.terrainProvider;
            for (i = 0, len = imageryLayerCollection.length; i < len; ++i) {
                var layer = imageryLayerCollection.get(i);
                if (layer.show) {
                    layer._createTileImagerySkeletons(tile, terrainProvider);
                }
            }
        }

        for (i = 0, len = tileImageryCollection.length; i < len; ++i) {
            var tileImagery = tileImageryCollection[i];
            if (!defined(tileImagery.loadingImagery)) {
                continue;
            }

            if (tileImagery.loadingImagery.state === ImageryState.PLACEHOLDER) {
                var imageryLayer = tileImagery.loadingImagery.imageryLayer;
                if (imageryLayer.imageryProvider.ready) {
                    // Remove the placeholder and add the actual skeletons (if any)
                    // at the same position.  Then continue the loop at the same index.
                    tileImagery.freeResources();
                    tileImageryCollection.splice(i, 1);
                    imageryLayer._createTileImagerySkeletons(tile, tileProvider.terrainProvider, i);
                    --i;
                    len = tileImageryCollection.length;
                    continue;
                }
            }

            tileImagery.processStateMachine(tile, frameState, true);
        }

        var stop = performance.now();

        //console.log('fill: ' + (stop - start));
    }

    var otherPassesInitialColor = new Cartesian4(0.0, 0.0, 0.0, 0.0);

    function addDrawCommandsForTile(tileProvider, tile, frameState, subset) {
        var surfaceTile = tile.data;

        if (surfaceTile.renderableTile !== undefined) {
            // We can't render this tile yet, so instead render a subset of our closest renderable ancestor.
            var missingTileStrategy = tileProvider.missingTileStrategy;
            if (missingTileStrategy === MissingTileStrategy.RENDER_ANCESTOR_SUBSET) {
                addDrawCommandsForTile(tileProvider, surfaceTile.renderableTile, frameState, surfaceTile.renderableTileSubset);
                return;
            } else if (missingTileStrategy === MissingTileStrategy.CREATE_FILL_TILE) {
                createFillTile(tileProvider, tile, frameState);
            }
        }

        //>>includeStart('debug', pragmas.debug);
        // if (!tile.renderable) {
        //     throw new DeveloperError('A rendered tile is not renderable, this should not be possible.');
        // }
        //>>includeEnd('debug');

        var creditDisplay = frameState.creditDisplay;

        var terrainData = surfaceTile.terrainData;
        if (defined(terrainData) && defined(terrainData.credits)) {
            var tileCredits = terrainData.credits;
            for (var tileCreditIndex = 0,
                     tileCreditLength = tileCredits.length; tileCreditIndex < tileCreditLength; ++tileCreditIndex) {
                creditDisplay.addCredit(tileCredits[tileCreditIndex]);
            }
        }

        var maxTextures = ContextLimits.maximumTextureImageUnits;

        var waterMaskTexture = surfaceTile.waterMaskTexture;
        var showReflectiveOcean = tileProvider.hasWaterMask && defined(waterMaskTexture);
        var oceanNormalMap = tileProvider.oceanNormalMap;
        var showOceanWaves = showReflectiveOcean && defined(oceanNormalMap);
        var hasVertexNormals = tileProvider.terrainProvider.ready && tileProvider.terrainProvider.hasVertexNormals;
        var enableFog = frameState.fog.enabled;
        var castShadows = ShadowMode.castShadows(tileProvider.shadows);
        var receiveShadows = ShadowMode.receiveShadows(tileProvider.shadows);

        if (showReflectiveOcean) {
            --maxTextures;
        }
        if (showOceanWaves) {
            --maxTextures;
        }

        var mesh = surfaceTile.vertexArray ? surfaceTile.mesh : surfaceTile.fillMesh;
        var rtc = mesh.center;
        var encoding = mesh.encoding;

        // Not used in 3D.
        var tileRectangle = tileRectangleScratch;

        // Only used for Mercator projections.
        var southLatitude = 0.0;
        var northLatitude = 0.0;
        var southMercatorY = 0.0;
        var oneOverMercatorHeight = 0.0;

        var useWebMercatorProjection = false;

        if (frameState.mode !== SceneMode.SCENE3D) {
            var projection = frameState.mapProjection;
            var southwest = projection.project(Rectangle.southwest(tile.rectangle), southwestScratch);
            var northeast = projection.project(Rectangle.northeast(tile.rectangle), northeastScratch);

            tileRectangle.x = southwest.x;
            tileRectangle.y = southwest.y;
            tileRectangle.z = northeast.x;
            tileRectangle.w = northeast.y;

            // In 2D and Columbus View, use the center of the tile for RTC rendering.
            if (frameState.mode !== SceneMode.MORPHING) {
                rtc = rtcScratch;
                rtc.x = 0.0;
                rtc.y = (tileRectangle.z + tileRectangle.x) * 0.5;
                rtc.z = (tileRectangle.w + tileRectangle.y) * 0.5;
                tileRectangle.x -= rtc.y;
                tileRectangle.y -= rtc.z;
                tileRectangle.z -= rtc.y;
                tileRectangle.w -= rtc.z;
            }

            if (frameState.mode === SceneMode.SCENE2D && encoding.quantization === TerrainQuantization.BITS12) {
                // In 2D, the texture coordinates of the tile are interpolated over the rectangle to get the position in the vertex shader.
                // When the texture coordinates are quantized, error is introduced. This can be seen through the 1px wide cracking
                // between the quantized tiles in 2D. To compensate for the error, move the expand the rectangle in each direction by
                // half the error amount.
                var epsilon = (1.0 / (Math.pow(2.0, 12.0) - 1.0)) * 0.5;
                var widthEpsilon = (tileRectangle.z - tileRectangle.x) * epsilon;
                var heightEpsilon = (tileRectangle.w - tileRectangle.y) * epsilon;
                tileRectangle.x -= widthEpsilon;
                tileRectangle.y -= heightEpsilon;
                tileRectangle.z += widthEpsilon;
                tileRectangle.w += heightEpsilon;
            }

            if (projection instanceof WebMercatorProjection) {
                southLatitude = tile.rectangle.south;
                northLatitude = tile.rectangle.north;

                southMercatorY = WebMercatorProjection.geodeticLatitudeToMercatorAngle(southLatitude);

                oneOverMercatorHeight = 1.0 / (WebMercatorProjection.geodeticLatitudeToMercatorAngle(northLatitude) - southMercatorY);

                useWebMercatorProjection = true;
            }
        }

        var tileImageryCollection = surfaceTile.imagery;
        var imageryIndex = 0;
        var imageryLen = tileImageryCollection.length;

        var firstPassRenderState = tileProvider._renderState;
        var otherPassesRenderState = tileProvider._blendRenderState;
        var renderState = firstPassRenderState;

        var initialColor = tileProvider._firstPassInitialColor;

        var context = frameState.context;

        if (!defined(tileProvider._debug.boundingSphereTile)) {
            debugDestroyPrimitive();
        }

        do {
            var numberOfDayTextures = 0;

            var command;
            var uniformMap;

            if (tileProvider._drawCommands.length <= tileProvider._usedDrawCommands) {
                command = new DrawCommand();
                command.owner = tile;
                command.cull = false;
                command.boundingVolume = new BoundingSphere();
                command.orientedBoundingBox = undefined;

                uniformMap = createTileUniformMap(frameState, tileProvider);

                tileProvider._drawCommands.push(command);
                tileProvider._uniformMaps.push(uniformMap);
            } else {
                command = tileProvider._drawCommands[tileProvider._usedDrawCommands];
                uniformMap = tileProvider._uniformMaps[tileProvider._usedDrawCommands];
            }

            command.owner = tile;

            ++tileProvider._usedDrawCommands;

            if (tile === tileProvider._debug.boundingSphereTile) {
                var obb = surfaceTile.orientedBoundingBox;
                // If a debug primitive already exists for this tile, it will not be
                // re-created, to avoid allocation every frame. If it were possible
                // to have more than one selected tile, this would have to change.
                if (defined(obb)) {
                    getDebugOrientedBoundingBox(obb, Color.RED).update(frameState);
                } else if (defined(mesh) && defined(mesh.boundingSphere3D)) {
                    getDebugBoundingSphere(mesh.boundingSphere3D, Color.RED).update(frameState);
                }
            }

            var uniformMapProperties = uniformMap.properties;
            Cartesian4.clone(initialColor, uniformMapProperties.initialColor);
            uniformMapProperties.oceanNormalMap = oceanNormalMap;
            uniformMapProperties.lightingFadeDistance.x = tileProvider.lightingFadeOutDistance;
            uniformMapProperties.lightingFadeDistance.y = tileProvider.lightingFadeInDistance;
            uniformMapProperties.zoomedOutOceanSpecularIntensity = tileProvider.zoomedOutOceanSpecularIntensity;

            uniformMapProperties.center3D = mesh.center;
            Cartesian3.clone(rtc, uniformMapProperties.rtc);

            Cartesian4.clone(tileRectangle, uniformMapProperties.tileRectangle);
            uniformMapProperties.southAndNorthLatitude.x = southLatitude;
            uniformMapProperties.southAndNorthLatitude.y = northLatitude;
            uniformMapProperties.southMercatorYAndOneOverHeight.x = southMercatorY;
            uniformMapProperties.southMercatorYAndOneOverHeight.y = oneOverMercatorHeight;

            if (subset !== undefined) {
                Cartesian4.clone(subset, uniformMapProperties.textureCoordinateSubset);
            }

            // For performance, use fog in the shader only when the tile is in fog.
            var applyFog = enableFog && CesiumMath.fog(tile._distance, frameState.fog.density) > CesiumMath.EPSILON3;

            var applyBrightness = false;
            var applyContrast = false;
            var applyHue = false;
            var applySaturation = false;
            var applyGamma = false;
            var applyAlpha = false;
            var applySplit = false;

            while (numberOfDayTextures < maxTextures && imageryIndex < imageryLen) {
                var tileImagery = tileImageryCollection[imageryIndex];
                var imagery = tileImagery.readyImagery;
                ++imageryIndex;

                if (!defined(imagery) || imagery.imageryLayer.alpha === 0.0) {
                    continue;
                }

                var texture = tileImagery.useWebMercatorT ? imagery.textureWebMercator : imagery.texture;

                //>>includeStart('debug', pragmas.debug);
                if (!defined(texture)) {
                    // Our "ready" texture isn't actually ready.  This should never happen.
                    //
                    // Side note: It IS possible for it to not be in the READY ImageryState, though.
                    // This can happen when a single imagery tile is shared by two terrain tiles (common)
                    // and one of them (A) needs a geographic version of the tile because it is near the poles,
                    // and the other (B) does not.  B can and will transition the imagery tile to the READY state
                    // without reprojecting to geographic.  Then, later, A will deem that same tile not-ready-yet
                    // because it only has the Web Mercator texture, and flip it back to the TRANSITIONING state.
                    // The imagery tile won't be in the READY state anymore, but it's still READY enough for B's
                    // purposes.
                    throw new DeveloperError('readyImagery is not actually ready!');
                }
                //>>includeEnd('debug');

                var imageryLayer = imagery.imageryLayer;

                if (!defined(tileImagery.textureTranslationAndScale)) {
                    tileImagery.textureTranslationAndScale = imageryLayer._calculateTextureTranslationAndScale(tile, tileImagery);
                }

                uniformMapProperties.dayTextures[numberOfDayTextures] = texture;
                uniformMapProperties.dayTextureTranslationAndScale[numberOfDayTextures] = tileImagery.textureTranslationAndScale;
                uniformMapProperties.dayTextureTexCoordsRectangle[numberOfDayTextures] = tileImagery.textureCoordinateRectangle;
                uniformMapProperties.dayTextureUseWebMercatorT[numberOfDayTextures] = tileImagery.useWebMercatorT;

                uniformMapProperties.dayTextureAlpha[numberOfDayTextures] = imageryLayer.alpha;
                applyAlpha = applyAlpha || uniformMapProperties.dayTextureAlpha[numberOfDayTextures] !== 1.0;

                uniformMapProperties.dayTextureBrightness[numberOfDayTextures] = imageryLayer.brightness;
                applyBrightness = applyBrightness || uniformMapProperties.dayTextureBrightness[numberOfDayTextures] !== ImageryLayer.DEFAULT_BRIGHTNESS;

                uniformMapProperties.dayTextureContrast[numberOfDayTextures] = imageryLayer.contrast;
                applyContrast = applyContrast || uniformMapProperties.dayTextureContrast[numberOfDayTextures] !== ImageryLayer.DEFAULT_CONTRAST;

                uniformMapProperties.dayTextureHue[numberOfDayTextures] = imageryLayer.hue;
                applyHue = applyHue || uniformMapProperties.dayTextureHue[numberOfDayTextures] !== ImageryLayer.DEFAULT_HUE;

                uniformMapProperties.dayTextureSaturation[numberOfDayTextures] = imageryLayer.saturation;
                applySaturation = applySaturation || uniformMapProperties.dayTextureSaturation[numberOfDayTextures] !== ImageryLayer.DEFAULT_SATURATION;

                uniformMapProperties.dayTextureOneOverGamma[numberOfDayTextures] = 1.0 / imageryLayer.gamma;
                applyGamma = applyGamma || uniformMapProperties.dayTextureOneOverGamma[numberOfDayTextures] !== 1.0 / ImageryLayer.DEFAULT_GAMMA;

                uniformMapProperties.dayTextureSplit[numberOfDayTextures] = imageryLayer.splitDirection;
                applySplit = applySplit || uniformMapProperties.dayTextureSplit[numberOfDayTextures] !== 0.0;

                if (defined(imagery.credits)) {
                    var credits = imagery.credits;
                    for (var creditIndex = 0, creditLength = credits.length; creditIndex < creditLength; ++creditIndex) {
                        creditDisplay.addCredit(credits[creditIndex]);
                    }
                }

                ++numberOfDayTextures;
            }

            // trim texture array to the used length so we don't end up using old textures
            // which might get destroyed eventually
            uniformMapProperties.dayTextures.length = numberOfDayTextures;
            uniformMapProperties.waterMask = waterMaskTexture;
            Cartesian4.clone(surfaceTile.waterMaskTranslationAndScale, uniformMapProperties.waterMaskTranslationAndScale);

            uniformMapProperties.minMaxHeight.x = encoding.minimumHeight;
            uniformMapProperties.minMaxHeight.y = encoding.maximumHeight;
            Matrix4.clone(encoding.matrix, uniformMapProperties.scaleAndBias);

            // update clipping planes
            var clippingPlanes = tileProvider._clippingPlanes;
            var clippingPlanesEnabled = defined(clippingPlanes) && clippingPlanes.enabled && tile.isClipped;
            if (clippingPlanesEnabled) {
                uniformMapProperties.clippingPlanesEdgeColor = Color.clone(clippingPlanes.edgeColor, uniformMapProperties.clippingPlanesEdgeColor);
                uniformMapProperties.clippingPlanesEdgeWidth = clippingPlanes.edgeWidth;
            }

            if (defined(tileProvider.uniformMap)) {
                uniformMap = combine(uniformMap, tileProvider.uniformMap);
            }

            command.shaderProgram = tileProvider._surfaceShaderSet.getShaderProgram(frameState, surfaceTile, numberOfDayTextures, applyBrightness, applyContrast, applyHue, applySaturation, applyGamma, applyAlpha, applySplit, showReflectiveOcean, showOceanWaves, tileProvider.enableLighting, hasVertexNormals, useWebMercatorProjection, applyFog, clippingPlanesEnabled, clippingPlanes, subset !== undefined);
            command.castShadows = castShadows;
            command.receiveShadows = receiveShadows;
            command.renderState = renderState;
            command.primitiveType = PrimitiveType.TRIANGLES;
            command.vertexArray = surfaceTile.vertexArray || surfaceTile.fillVertexArray;
            command.uniformMap = uniformMap;
            command.pass = Pass.GLOBE;

            if (tileProvider._debug.wireframe) {
                createWireframeVertexArrayIfNecessary(context, tileProvider, tile);
                if (defined(surfaceTile.wireframeVertexArray)) {
                    command.vertexArray = surfaceTile.wireframeVertexArray;
                    command.primitiveType = PrimitiveType.LINES;
                }
            }

            var boundingVolume = command.boundingVolume;
            var orientedBoundingBox = command.orientedBoundingBox;

            if (frameState.mode !== SceneMode.SCENE3D) {
                var tileBoundingRegion = surfaceTile.tileBoundingRegion;
                BoundingSphere.fromRectangleWithHeights2D(tile.rectangle, frameState.mapProjection, tileBoundingRegion.minimumHeight, tileBoundingRegion.maximumHeight, boundingVolume);
                Cartesian3.fromElements(boundingVolume.center.z, boundingVolume.center.x, boundingVolume.center.y, boundingVolume.center);

                if (frameState.mode === SceneMode.MORPHING) {
                    boundingVolume = BoundingSphere.union(mesh.boundingSphere3D, boundingVolume, boundingVolume);
                }
            } else {
                command.boundingVolume = BoundingSphere.clone(mesh.boundingSphere3D, boundingVolume);
                command.orientedBoundingBox = OrientedBoundingBox.clone(surfaceTile.orientedBoundingBox, orientedBoundingBox);
            }

            frameState.commandList.push(command);

            renderState = otherPassesRenderState;
            initialColor = otherPassesInitialColor;
        } while (imageryIndex < imageryLen);
    }

    return GlobeSurfaceTileProvider;
});
