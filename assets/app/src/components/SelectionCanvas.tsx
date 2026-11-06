import {useRef, useState, type PointerEvent as ReactPointerEvent, type CSSProperties} from 'react';
import {getSmoothClosedCurvePath, MAX_CLOSED_POLYGON_POINTS, sanitizeClosedPolygon} from '../core/regionGeometry';
import {clamp, getPointsBounds, normalizeRect, translatePolygonEdge} from '../core/utils';
import {makeRegion, moveRegion} from '../core/project';
import type {IllustrationRegion, IllustrationScene, NormalizedPoint, NormalizedRect} from '../core/types';

export type SelectionTool = 'select' | 'rectangle' | 'freehand' | 'hide';
type Edge = 'left' | 'right' | 'top' | 'bottom';
type Operation = {pointer: number; start: NormalizedPoint; capture: Element} & (
  | {kind: 'draw'; tool: SelectionTool; points: NormalizedPoint[]}
  | {kind: 'move' | 'resize' | 'edge'; region: IllustrationRegion; edge?: Edge; edgeIndex?: number}
);
const handles: {edge: Edge; left: number; top: number; label: string}[] = [
  {edge: 'top', left: 50, top: 0, label: '上边'}, {edge: 'right', left: 100, top: 50, label: '右边'},
  {edge: 'bottom', left: 50, top: 100, label: '下边'}, {edge: 'left', left: 0, top: 50, label: '左边'},
];
// 与原项目一致：每条可编辑边显示一个控制点，复杂轮廓最多 64 个。
const getEdgeHandleIndices = (pointCount: number) => {
  const handleCount = Math.min(pointCount, MAX_CLOSED_POLYGON_POINTS);
  return Array.from({length: handleCount}, (_, index) => Math.floor(index * pointCount / handleCount));
};
const styleFor = (rect: NormalizedRect): CSSProperties => ({left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`, height: `${rect.height * 100}%`});

export function SelectionCanvas({scene, tool, selectedId, onSelect, onAdd, onCommit}: {
  scene: IllustrationScene;
  tool: SelectionTool;
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: (region: IllustrationRegion) => void;
  onCommit: (region: IllustrationRegion) => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const operation = useRef<Operation | null>(null);
  const [draft, setDraft] = useState<IllustrationRegion | null>(null);
  const pointAt = (event: ReactPointerEvent): NormalizedPoint => {
    const box = overlay.current!.getBoundingClientRect();
    return {x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1)};
  };
  const begin = (event: ReactPointerEvent, region?: IllustrationRegion, edge?: Edge, edgeIndex?: number) => {
    if (event.button !== 0) return;
    if (region) onSelect(region.id);
    event.preventDefault();
    event.stopPropagation();
    if (region?.locked) return;
    const capture = event.currentTarget;
    capture.setPointerCapture(event.pointerId);
    const start = pointAt(event);
    if (region) {
      operation.current = {pointer: event.pointerId, start, capture, kind: edge ? 'resize' : edgeIndex !== undefined ? 'edge' : 'move',
        region, edge, edgeIndex};
      setDraft(region);
    } else if (tool !== 'select') {
      operation.current = {pointer: event.pointerId, start, capture, kind: 'draw', tool, points: [start]};
      setDraft(makeRegion({x: start.x, y: start.y, width: 0.001, height: 0.001}, [], tool === 'hide'));
    } else onSelect('');
  };
  const update = (event: ReactPointerEvent): IllustrationRegion | null => {
    const op = operation.current;
    if (!op || op.pointer !== event.pointerId) return null;
    const point = pointAt(event);
    let next: IllustrationRegion;
    if (op.kind === 'draw') {
      if (op.tool === 'freehand') {
        const last = op.points.at(-1)!;
        if (Math.hypot(point.x - last.x, point.y - last.y) > 0.002) op.points.push(point);
        const points = op.points.length > 300 ? op.points.filter((_, index) => index % 2 === 0) : op.points;
        op.points = points;
        next = makeRegion(getPointsBounds(points), points);
      } else {
        const rect = {x: Math.min(op.start.x, point.x), y: Math.min(op.start.y, point.y),
          width: Math.abs(op.start.x - point.x), height: Math.abs(op.start.y - point.y)};
        next = {...makeRegion(rect, [], op.tool === 'hide'), rect};
      }
    } else if (op.kind === 'move') next = moveRegion(op.region, point.x - op.start.x, point.y - op.start.y);
    else if (op.kind === 'edge') {
      const points = translatePolygonEdge(op.region.points, op.edgeIndex!, point.x - op.start.x, point.y - op.start.y);
      next = {...op.region, points, rect: getPointsBounds(points)};
    } else {
      const rect = {...op.region.rect};
      const right = rect.x + rect.width;
      const bottom = rect.y + rect.height;
      if (op.edge === 'left') {rect.x = clamp(point.x, 0, right - 0.02); rect.width = right - rect.x;}
      if (op.edge === 'top') {rect.y = clamp(point.y, 0, bottom - 0.02); rect.height = bottom - rect.y;}
      if (op.edge === 'right') rect.width = clamp(point.x, op.region.rect.x + 0.02, 1) - op.region.rect.x;
      if (op.edge === 'bottom') rect.height = clamp(point.y, op.region.rect.y + 0.02, 1) - op.region.rect.y;
      next = {...op.region, rect: normalizeRect(rect)};
    }
    setDraft(next);
    return next;
  };
  const finish = (event: ReactPointerEvent, cancelled = false) => {
    const op = operation.current;
    if (!op || op.pointer !== event.pointerId) return;
    const next = cancelled ? null : update(event);
    operation.current = null;
    setDraft(null);
    if (op.capture.hasPointerCapture(event.pointerId)) op.capture.releasePointerCapture(event.pointerId);
    if (!next) return;
    if (op.kind === 'draw' && (next.rect.width < 0.015 || next.rect.height < 0.015
      || (op.tool === 'freehand' && op.points.length < 3))) return;
    if (op.kind === 'draw' && next.selectionType === 'freehand') {
      next.points = sanitizeClosedPolygon(next.points);
      if (next.points.length < 3) return;
      next.rect = getPointsBounds(next.points);
    }
    if (op.kind === 'draw') onAdd(next);
    else onCommit(next);
  };
  const regions = scene.regions.map((region) => draft?.id === region.id ? draft : region);
  if (operation.current?.kind === 'draw' && draft) regions.push(draft);

  return <div ref={overlay} className={`selection-overlay tool-${tool}`} onPointerDown={(event) => begin(event)}
    onPointerMove={(event) => {update(event);}} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}>
    {regions.map((region, index) => {
      const selected = region.id === selectedId || region === draft;
      const polygon = region.selectionType === 'freehand' && region.points.length >= 3;
      return <div key={region.id} className={`region-box ${selected ? 'selected' : ''} ${polygon ? 'polygon' : ''} ${region.alwaysHidden ? 'hidden-region' : ''}`}
        style={{...styleFor(region.rect), zIndex: selected ? 500 : region.zIndex,
          pointerEvents: tool === 'select' && !region.isAutoLast ? 'auto' : 'none'}}
        onPointerDown={(event) => begin(event, region)}>
        {polygon ? <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><path d={getSmoothClosedCurvePath(region.points.map((p) => ({
          x: (p.x - region.rect.x) / region.rect.width, y: (p.y - region.rect.y) / region.rect.height,
        })))} /></svg> : null}
        <span className="region-label">{region.alwaysHidden ? '隐藏' : index + 1}{region.locked ? ' · 锁定' : ''}</span>
        {selected && !region.locked && operation.current?.kind !== 'draw' ? (polygon
          ? getEdgeHandleIndices(region.points.length).map((i) => {
            const p = region.points[i];
            return <button key={i} type="button" className="edge-handle" aria-label={`调整选区第 ${i + 1} 条边`} title="拖动调整这条边" style={{
              left: `${(((p.x + region.points[(i + 1) % region.points.length].x) / 2 - region.rect.x) / region.rect.width) * 100}%`,
              top: `${(((p.y + region.points[(i + 1) % region.points.length].y) / 2 - region.rect.y) / region.rect.height) * 100}%`,
            }} onPointerDown={(event) => begin(event, region, undefined, i)} />;
          })
          : handles.map((handle) => <button key={handle.edge} type="button" className="edge-handle rectangle-edge" data-edge={handle.edge}
            aria-label={`调整选区${handle.label}`} title={`拖动调整矩形${handle.label}`}
            style={{left: `${handle.left}%`, top: `${handle.top}%`}} onPointerDown={(event) => begin(event, region, handle.edge)} />)) : null}
      </div>;
    })}
  </div>;
}
