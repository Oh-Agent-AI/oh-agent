import { useState } from "react";
import type { CityAnchorGeometryV1, CityAnchorV1 } from "@oh-agent/city-sdk";

export type VenueGeometry = ReadonlyMap<string, CityAnchorGeometryV1>;
export type VenueRoad = readonly CityAnchorGeometryV1["positionMeters"][];

export function VenueMap({ geometry, roads, entries, targets, entryId, orderedIds, disabled, onEntry, onTarget }: {
  geometry: VenueGeometry;
  roads: readonly VenueRoad[];
  entries: readonly CityAnchorV1[];
  targets: readonly CityAnchorV1[];
  entryId: string;
  orderedIds: readonly string[];
  disabled: boolean;
  onEntry: (id: string) => void;
  onTarget: (id: string) => void;
}) {
  const [pickingEntry, setPickingEntry] = useState(false);
  const [zoom, setZoom] = useState(1);
  const byId = new Map([...entries, ...targets].map(anchor => [anchor.id, geometry.get(anchor.geometryRef)?.positionMeters]));
  const markers = (pickingEntry ? entries : targets).flatMap((anchor, index) => {
    const point = byId.get(anchor.id);
    return point ? [{ id: anchor.id, point, index }] : [];
  });
  const points = [...byId.values()].filter(point => point !== undefined);
  if (!points.length) return <p className="muted">这个城市场景暂时没有可在地图上定位的场地点位。</p>;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  const extent = Math.max(maxX - minX, maxZ - minZ, 10) * 1.16;
  const center = zoom > 1 && byId.get(entryId);
  const centerX = center ? center.x : (maxX + minX) / 2;
  const centerZ = center ? center.z : (maxZ + minZ) / 2;
  const size = extent / zoom;
  const scale = 280 / size;
  const pixel = (point: { x: number; z: number }) =>
    `${(point.x - centerX) * scale + 140},${(point.z - centerZ) * scale + 140}`;
  const sequence = [entryId, ...orderedIds].map(id => byId.get(id));
  const renderMarker = (point: { x: number; z: number }, label: string, active: boolean) =>
    <g transform={`translate(${pixel(point)})`} className={active ? "venue-map-active" : "venue-map-dot"}>
      <circle r={active ? 8 : 4} />
      {label && <text textAnchor="middle" dominantBaseline="central">{label}</text>}
    </g>;
  return <div className="venue-map">
    <div className="actions">
      <button type="button" className="secondary" aria-pressed={pickingEntry} onClick={() => setPickingEntry(true)}>选起点</button>
      <button type="button" className="secondary" aria-pressed={!pickingEntry} onClick={() => setPickingEntry(false)}>选路线点</button>
      <button type="button" className="secondary" aria-label="缩小地图" disabled={zoom <= 1} onClick={() => setZoom(zoom / 2)}>−</button>
      <button type="button" className="secondary" aria-label="放大地图" disabled={zoom >= 8} onClick={() => setZoom(zoom * 2)}>+</button>
    </div>
    <svg viewBox="0 0 280 280" aria-label="场地路线地图">
      {roads.map((road, index) => <polyline key={index} points={road.map(pixel).join(" ")} className="venue-map-road" />)}
      {sequence.map((point, index) => {
        const previous = sequence[index - 1];
        return previous && point ? <polyline key={index} points={`${pixel(previous)} ${pixel(point)}`} className="venue-map-order" /> : null;
      })}
      {!pickingEntry && sequence[0] && renderMarker(sequence[0], "起", true)}
      {markers.filter(({ point }) => {
        const x = (point.x - centerX) * scale + 140;
        const z = (point.z - centerZ) * scale + 140;
        return x >= 0 && x <= 280 && z >= 0 && z <= 280;
      }).map(({ id, point, index }) => {
        const order = orderedIds.indexOf(id);
        const active = pickingEntry ? id === entryId : order >= 0;
        const choose = () => {
          if (disabled) return;
          if (pickingEntry) { onEntry(id); setPickingEntry(false); }
          else onTarget(id);
        };
        return <g key={id} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-pressed={active}
          aria-label={pickingEntry ? `可选起点 ${index + 1}` : active ? `移除路线第 ${order + 1} 点` : `添加路线候选点 ${index + 1}`}
          onClick={choose} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } }}>
          {renderMarker(point, active ? pickingEntry ? "起" : String(order + 1) : "", active)}
          <circle cx={(point.x - centerX) * scale + 140} cy={(point.z - centerZ) * scale + 140} r={8} fill="transparent" />
        </g>;
      })}
    </svg>
    <p className="muted">虚线表示经过顺序。再次点击已选点可移除。</p>
  </div>;
}
