import {Matrix4} from 'math.gl';
import {MVTLoader} from '@loaders.gl/mvt';
import {load} from '@loaders.gl/core';
import {COORDINATE_SYSTEM} from '@deck.gl/core';

import TileLayer from '../tile-layer/tile-layer';
import {getURLFromTemplate, isURLTemplate} from '../tile-layer/utils';
import ClipExtension from './clip-extension';
import {transform} from './coordinate-transform';

const WORLD_SIZE = 512;

const defaultProps = {
  uniqueIdProperty: {type: 'string', value: ''},
  highlightedFeatureId: null,
  onViewportChange: {type: 'function', optional: true, value: null, compare: false}
};

async function fetchTileJSON(url) {
  try {
    return await load(url);
  } catch (error) {
    throw new Error(`An error occurred fetching TileJSON: ${error}`);
  }
}

export default class MVTLayer extends TileLayer {
  initializeState() {
    super.initializeState();
    this.setState({
      data: null,
      tileJSON: null
    });
  }

  get isLoaded() {
    return this.state.data && this.state.tileset && super.isLoaded;
  }

  updateState({props, oldProps, context, changeFlags}) {
    if (changeFlags.dataChanged) {
      this._updateTileData({props});
    }

    if (this.state.data) {
      super.updateState({props, oldProps, context, changeFlags});
      const {tileset} = this.state;
      if (changeFlags.viewportChanged && tileset.isLoaded) {
        this._onViewportChange();
      }
    }
  }

  async _updateTileData({props}) {
    const {onDataLoad} = this.props;
    let {data} = props;
    let tileJSON = null;
    let {minZoom, maxZoom} = props;

    if (typeof data === 'string' && !isURLTemplate(data)) {
      this.setState({data: null, tileJSON: null});
      tileJSON = await fetchTileJSON(data);

      if (onDataLoad) {
        onDataLoad(tileJSON);
      }
    } else if (data.tilejson) {
      tileJSON = data;
    }

    if (tileJSON) {
      data = tileJSON.tiles;

      if (Number.isFinite(tileJSON.minzoom) && tileJSON.minzoom > minZoom) {
        minZoom = tileJSON.minzoom;
      }

      if (
        Number.isFinite(tileJSON.maxzoom) &&
        (!Number.isFinite(maxZoom) || tileJSON.maxzoom < maxZoom)
      ) {
        maxZoom = tileJSON.maxzoom;
      }
    }

    this.setState({data, tileJSON, minZoom, maxZoom});
  }

  renderLayers() {
    if (!this.state.data) return null;
    return super.renderLayers();
  }

  getTileData(tile) {
    const url = getURLFromTemplate(this.state.data, tile);
    if (!url) {
      return Promise.reject('Invalid URL');
    }
    let options = this.getLoadOptions();
    options = {
      ...options,
      mvt: {
        ...(options && options.mvt),
        coordinates: this.context.viewport.resolution ? 'wgs84' : 'local',
        tileIndex: {x: tile.x, y: tile.y, z: tile.z}
      }
    };
    return load(url, MVTLoader, options);
  }

  renderSubLayers(props) {
    const {tile} = props;

    const modelMatrix = new Matrix4().scale(getModelMatrixScale(tile));

    props.autoHighlight = false;

    if (!this.context.viewport.resolution) {
      props.modelMatrix = modelMatrix;
      props.coordinateOrigin = getCoordinateOrigin(tile);
      props.coordinateSystem = COORDINATE_SYSTEM.CARTESIAN;
      props.extensions = [...(props.extensions || []), new ClipExtension()];
    }

    return super.renderSubLayers(props);
  }

  onHover(info, pickingEvent) {
    const {uniqueIdProperty, autoHighlight} = this.props;

    if (autoHighlight) {
      const {hoveredFeatureId} = this.state;
      const hoveredFeature = info.object;
      let newHoveredFeatureId;

      if (hoveredFeature) {
        newHoveredFeatureId = getFeatureUniqueId(hoveredFeature, uniqueIdProperty);
      }

      if (hoveredFeatureId !== newHoveredFeatureId && newHoveredFeatureId !== -1) {
        this.setState({hoveredFeatureId: newHoveredFeatureId});
      }
    }

    return super.onHover(info, pickingEvent);
  }

  getPickingInfo(params) {
    const info = super.getPickingInfo(params);

    const isWGS84 = this.context.viewport.resolution;

    if (!isWGS84 && info.object) {
      info.object = transformTileCoordsToWGS84(info.object, info.tile, this.context.viewport);
    }

    return info;
  }

  getHighlightedObjectIndex(tile) {
    const {hoveredFeatureId} = this.state;
    const {uniqueIdProperty, highlightedFeatureId} = this.props;
    const {data} = tile;

    const isFeatureIdPresent =
      isFeatureIdDefined(hoveredFeatureId) || isFeatureIdDefined(highlightedFeatureId);

    if (!isFeatureIdPresent || !Array.isArray(data)) {
      return -1;
    }

    const featureIdToHighlight = isFeatureIdDefined(highlightedFeatureId)
      ? highlightedFeatureId
      : hoveredFeatureId;

    return data.findIndex(
      feature => getFeatureUniqueId(feature, uniqueIdProperty) === featureIdToHighlight
    );
  }

  _pickObjects(maxObjects) {
    const {deck, viewport} = this.context;
    const width = viewport.width;
    const height = viewport.height;
    const x = viewport.x;
    const y = viewport.y;
    const layerIds = [this.id];
    return deck.pickObjects({x, y, width, height, layerIds, maxObjects});
  }

  getRenderedFeatures(maxFeatures = null) {
    const features = this._pickObjects(maxFeatures);
    const featureCache = new Set();
    const renderedFeatures = [];

    for (const f of features) {
      const featureId = getFeatureUniqueId(f.object, this.props.uniqueIdProperty);

      if (featureId === -1) {
        // we have no id for the feature, we just add to the list
        renderedFeatures.push(f.object);
      } else if (!featureCache.has(featureId)) {
        // Add removing duplicates
        featureCache.add(featureId);
        renderedFeatures.push(f.object);
      }
    }

    return renderedFeatures;
  }

  getViewportFeatures() {
    const {tileset} = this.state;
    const {uniqueIdProperty} = this.props;
    const currentFrustumPlanes = this.context.viewport.getFrustumPlanes();
    const featureCache = new Set();
    let viewportFeatures = [];

    tileset.selectedTiles.forEach(tile => {
      const data = tile.data;

      if (!Array.isArray(data)) {
        return;
      }

      const transformationMatrix = new Matrix4()
        .translate(getCoordinateOrigin(tile))
        .scale(getModelMatrixScale(tile));

      viewportFeatures = viewportFeatures.concat(
        data.filter(f => {
          const featureId = getFeatureUniqueId(f, uniqueIdProperty);
          if (
            !featureCache.has(featureId) &&
            checkIfCoordsAreInsideFrustum(
              transformationMatrix,
              currentFrustumPlanes,
              f.geometry.coordinates
            )
          ) {
            featureCache.add(featureId);
            return true;
          }
          return false;
        })
      );
    });

    return viewportFeatures;
  }

  _onViewportChange() {
    const {viewport} = this.context;
    const {onViewportChange} = this.props;

    if (onViewportChange) {
      onViewportChange({
        getRenderedFeatures: this.getRenderedFeatures.bind(this),
        getViewportFeatures: this.getViewportFeatures.bind(this),
        viewport
      });
    }
  }

  _onViewportLoad() {
    super._onViewportLoad();
    this._onViewportChange();
  }
}

function getFeatureUniqueId(feature, uniqueIdProperty) {
  if (uniqueIdProperty) {
    return feature.properties[uniqueIdProperty];
  }

  if ('id' in feature) {
    return feature.id;
  }

  return -1;
}

function isFeatureIdDefined(value) {
  return value !== undefined && value !== null && value !== '';
}

function transformTileCoordsToWGS84(object, tile, viewport) {
  const feature = {
    ...object,
    geometry: {
      type: object.geometry.type
    }
  };

  // eslint-disable-next-line accessor-pairs
  Object.defineProperty(feature.geometry, 'coordinates', {
    get: () => {
      return transform(object.geometry, tile.bbox, viewport);
    }
  });

  return feature;
}

function getModelMatrixScale(tile) {
  const worldScale = Math.pow(2, tile.z);
  const xScale = WORLD_SIZE / worldScale;
  const yScale = -xScale;

  return [xScale, yScale, 1];
}

function getCoordinateOrigin(tile) {
  const worldScale = Math.pow(2, tile.z);
  const xOffset = (WORLD_SIZE * tile.x) / worldScale;
  const yOffset = WORLD_SIZE * (1 - tile.y / worldScale);

  return [xOffset, yOffset, 0];
}

function checkIfCoordsAreInsideFrustum(matrix, frustumPlanes, coords) {
  if (Array.isArray(coords) && coords.length && typeof coords[0] === 'number') {
    return coordIsInPlanes(frustumPlanes, matrix.transform(coords).concat(0));
  }

  return coords.some(c => {
    if (Array.isArray(c) && Array.isArray(c[0])) {
      return checkIfCoordsAreInsideFrustum(matrix, frustumPlanes, c);
    }

    return coordIsInPlanes(frustumPlanes, matrix.transform(c).concat(0));
  });
}

function coordIsInPlanes(frustumPlanes, coords) {
  return Object.keys(frustumPlanes).every(plane => {
    const {normal, distance} = frustumPlanes[plane];

    return normal.dot(coords) < distance;
  });
}

MVTLayer.layerName = 'MVTLayer';
MVTLayer.defaultProps = defaultProps;
