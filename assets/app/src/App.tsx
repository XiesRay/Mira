import {useCallback, useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent} from 'react';
import {AnimatedRegionLayers, AnimatedSceneFrame, AnimatedPreviousSceneFrame} from './components/PlaybackPreview';
import {PlaybackControls} from './components/PlaybackControls';
import {SelectionCanvas, type SelectionTool} from './components/SelectionCanvas';
import {usePlayback} from './components/usePlayback';
import {addRegions, arrangeScenes, downloadProject, emptyProject, makeRegion, markAutoLastRegion, MAX_PROJECT_BYTES, MAX_REGIONS, MAX_SCENES,
  parseProject, prepareExportProject, readImage, scheduleScene} from './core/project';
import {autoDetectRegions, detectImageBackgroundColor} from './core/regionDetect';
import {clamp} from './core/utils';
import {EXAMPLE_IMAGES} from './examples';
import type {ExportFormat, IllustrationRegion, IllustrationScene, Project, RegionEffect} from './core/types';

const effects: {value: RegionEffect; label: string}[] = [
  {value: 'appear', label: '直接出现'}, {value: 'fade', label: '淡入'}, {value: 'pop', label: '轻弹'},
  {value: 'slide-left', label: '从左滑入'}, {value: 'slide-right', label: '从右滑入'},
  {value: 'slide-up', label: '向上浮入'}, {value: 'wipe', label: '擦除揭示'},
];
type ExportJob = {id: string; format: ExportFormat; status: 'queued' | 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled'; progress: number; error?: string};

function useProjectHistory() {
  const [project, setProject] = useState(emptyProject);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const current = useRef(project);
  const commit = useCallback((value: Project | ((project: Project) => Project)) => {
    const next = typeof value === 'function' ? value(current.current) : value;
    if (next === current.current) return;
    past.current = [...past.current.slice(-29), current.current];
    future.current = [];
    current.current = next;
    setProject(next);
  }, []);
  const travel = (direction: 'undo' | 'redo') => {
    const source = direction === 'undo' ? past.current : future.current;
    const destination = direction === 'undo' ? future.current : past.current;
    const next = source.pop();
    if (!next) return;
    destination.push(current.current);
    current.current = next;
    setProject(next);
  };
  return {project, commit, undo: () => travel('undo'), redo: () => travel('redo'),
    canUndo: past.current.length > 0, canRedo: future.current.length > 0};
}

export default function App() {
  const {project, commit, undo, redo, canUndo, canRedo} = useProjectHistory();
  const [selectedSceneId, setSelectedSceneId] = useState('');
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [tool, setTool] = useState<SelectionTool>('rectangle');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('导入一张图片，自动识别可以逐步出现的区域。');
  const [error, setError] = useState('');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [preparingExport, setPreparingExport] = useState(false);
  const downloadedJobs = useRef(new Set<string>());
  const usageDialog = useRef<HTMLDialogElement>(null);
  const [exportSize, setExportSize] = useState('1080');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('mp4');
  const [zoom, setZoom] = useState(100);
  const [dirty, setDirty] = useState(false);
  const [draggedRegionId, setDraggedRegionId] = useState('');
  const [dropRegionId, setDropRegionId] = useState('');
  const [dropPlacement, setDropPlacement] = useState<'before' | 'after'>('before');
  const regionDrag = useRef<{pointer: number; sceneId: string; from: string; target: string;
    placement: 'before' | 'after'; capture: HTMLElement; x: number; y: number; active: boolean} | null>(null);
  const [preferredRegionCount, setPreferredRegionCount] = useState('');
  const [canvasBounds, setCanvasBounds] = useState({width: 640, height: 360});
  const canvasViewport = useRef<HTMLDivElement>(null);
  const imagesInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const playback = usePlayback(project.scenes);
  const exporting = !!job && ['queued', 'rendering', 'encoding'].includes(job.status);
  const exportProgress = preparingExport ? 0 : clamp(Math.round(job?.progress ?? 0), 0, 100);
  const scene = (playback.preview
    ? project.scenes.find((scene) => scene.id === playback.activeSceneId)
    : project.scenes.find((scene) => scene.id === selectedSceneId)) ?? project.scenes[0];
  const sceneIndex = scene ? project.scenes.indexOf(scene) : -1;
  const selected = scene?.regions.find((region) => region.id === selectedRegionId);
  const aspect = project.scenes[0] ? project.scenes[0].width / project.scenes[0].height : 16 / 9;
  const hasScene = !!scene;
  const fittedWidth = Math.min(canvasBounds.width, canvasBounds.height * aspect);
  const canvasWidth = fittedWidth * zoom / 100;
  const canvasHeight = canvasWidth / aspect;
  const sourceAspect = scene ? scene.width / scene.height : aspect;
  const frameWidth = sourceAspect > aspect ? 100 : sourceAspect / aspect * 100;
  const frameHeight = sourceAspect > aspect ? aspect / sourceAspect * 100 : 100;
  const imageFrameStyle = {position: 'absolute' as const, width: `${frameWidth}%`, height: `${frameHeight}%`,
    left: `${(100 - frameWidth) / 2}%`, top: `${(100 - frameHeight) / 2}%`};
  const fullFrameStyle = {position: 'absolute' as const, inset: 0, backgroundColor: scene?.backgroundColor};
  const previousScene = project.scenes[sceneIndex - 1];
  const previousAspect = previousScene ? previousScene.width / previousScene.height : aspect;
  const previousWidth = previousAspect > aspect ? 100 : previousAspect / aspect * 100;
  const previousHeight = previousAspect > aspect ? aspect / previousAspect * 100 : 100;
  const previousFrameStyle = {position: 'absolute' as const, width: `${previousWidth}%`, height: `${previousHeight}%`,
    left: `${(100 - previousWidth) / 2}%`, top: `${(100 - previousHeight) / 2}%`};
  const edit = useCallback((value: Project | ((project: Project) => Project)) => {
    commit(value);
    setDirty(true);
  }, [commit]);

  useEffect(() => {
    const viewport = canvasViewport.current;
    if (!viewport) return;
    const updateSize = () => setCanvasBounds({
      width: Math.max(1, viewport.clientWidth - 32),
      height: Math.max(1, viewport.clientHeight - 32),
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [hasScene]);

  const updateScene = (id: string, transform: (scene: IllustrationScene) => IllustrationScene) => {
    playback.pause();
    playback.setPreview(false);
    setSelectedSceneId(id);
    edit((project) => ({...project, scenes: arrangeScenes(project.scenes.map((scene) => scene.id === id ? transform(scene) : scene))}));
  };
  const updateRegion = (patch: Partial<IllustrationRegion>) => {
    if (!scene || !selected || selected.locked) return;
    updateScene(scene.id, (scene) => ({...scene, regions: scene.regions.map((region) => region.id === selected.id ? {...region, ...patch} : region)}));
  };
  const stopEditingPlayback = () => {playback.pause(); playback.setPreview(false);};
  const selectScene = (next: IllustrationScene) => {
    stopEditingPlayback();
    setSelectedSceneId(next.id);
    setSelectedRegionId('');
    playback.seek(next.startTime);
  };
  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError('');
    playback.pause();
    try {await action();} catch (error) {setError(error instanceof Error ? error.message : '操作失败');}
    finally {setBusy('');}
  };

  const appendImages = async (files: File[], example = false) => {
    if (project.scenes.length + files.length > MAX_SCENES) throw new Error('每个项目最多支持 30 张图片');
    const scenes: IllustrationScene[] = [];
    for (const file of files) {
      const next = await readImage(file);
      const [regions, backgroundColor] = await Promise.all([
        autoDetectRegions(next.imageUrl, {minRegionThreshold: 2, requireBackgroundSafe: true,
          preferredRegionCount: preferredRegionCount ? Number(preferredRegionCount) : undefined}),
        detectImageBackgroundColor(next.imageUrl),
      ]);
      const complete = scheduleScene({...next, backgroundColor, regions: markAutoLastRegion(regions
        .map((region) => makeRegion(region.rect, region.points)))});
      scenes.push(complete);
    }
    edit((project) => ({...project,
      name: example && !project.scenes.length ? 'Mirami 双图演示' : project.name,
      scenes: arrangeScenes([...project.scenes, ...scenes])}));
    setSelectedSceneId(scenes[0].id);
    setSelectedRegionId('');
    playback.setPreview(false);
    setTool('select');
    setMessage(example ? '双图案例已载入并自动框选。选择区域调整边界，拖动整条区域记录排序，点击播放预览。'
      : `已导入 ${scenes.length} 张图片并自动框选；可拖动边界修改，也可补画新选区。`);
  };
  const importImages = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length) void run('正在导入并自动框选…', () => appendImages(files));
  };
  const loadExamples = () => void run('正在载入双图案例并自动框选…', async () => {
    const files = await Promise.all(EXAMPLE_IMAGES.map(async (example) => {
      const response = await fetch(`./examples/${example.file}`);
      if (!response.ok) throw new Error(`无法读取案例：${example.title}`);
      return new File([await response.blob()], `${example.title}.png`, {type: 'image/png'});
    }));
    await appendImages(files, true);
  });

  const detect = () => {
    if (!scene) return;
    void run('正在自动框选…', async () => {
      const regions = await autoDetectRegions(scene.imageUrl, {minRegionThreshold: 2, requireBackgroundSafe: true,
        preferredRegionCount: preferredRegionCount ? Number(preferredRegionCount) : undefined});
      updateScene(scene.id, (scene) => scheduleScene({...scene, regions: markAutoLastRegion(regions
        .map((region) => makeRegion(region.rect, region.points)))}));
      setSelectedRegionId('');
      playback.setPreview(false);
      setTool('select');
      setMessage(`识别出 ${regions.length} 个区域。重新识别会替换当前页框选，可用撤销恢复。`);
    });
  };

  const importProject = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run('正在读取项目…', async () => {
      if (file.size > MAX_PROJECT_BYTES) throw new Error('项目文件不能超过 80 MB');
      const next = parseProject(JSON.parse(await file.text()));
      await Promise.all(next.scenes.map(async (scene) => {
        const image = new Image();
        image.src = scene.imageUrl;
        await image.decode();
        if (image.naturalWidth !== scene.width || image.naturalHeight !== scene.height) throw new Error('项目图片尺寸与内容不一致');
      }));
      edit(next);
      setDirty(false);
      setSelectedSceneId(next.scenes[0]?.id ?? '');
      setSelectedRegionId('');
      playback.setPreview(false);
      playback.seek(0);
      setMessage('项目已打开，图片和全部选区均已恢复。');
    });
  };

  const moveOrder = (index: number, delta: number) => {
    if (!scene) return;
    const regions = [...scene.regions];
    const target = index + delta;
    if (target < 0 || target >= regions.length || regions[index].locked || regions[target].locked
      || regions[index].isAutoLast || regions[target].isAutoLast) return;
    [regions[index], regions[target]] = [regions[target], regions[index]];
    updateScene(scene.id, (scene) => scheduleScene({...scene, regions}));
  };
  const beginRegionDrag = (event: ReactPointerEvent<HTMLElement>, region: IllustrationRegion) => {
    if ((event.target as Element).closest('[data-order-action]')) return;
    if (!scene || busy || region.locked || region.isAutoLast || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    regionDrag.current = {pointer: event.pointerId, sceneId: scene.id, from: region.id, target: '', placement: 'before',
      capture: event.currentTarget, x: event.clientX, y: event.clientY, active: false};
    stopEditingPlayback();
    setSelectedSceneId(scene.id);
    setSelectedRegionId(region.id);
  };
  const moveRegionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = regionDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.active = true;
      setDraggedRegionId(drag.from);
    }
    const list = event.currentTarget.closest('.region-list');
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-region-id]');
    const bounds = list?.getBoundingClientRect();
    if (list && bounds) {
      if (event.clientY < bounds.top + 24) list.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 24) list.scrollTop += 12;
    }
    if (!row || !list?.contains(row) || row.dataset.locked === 'true') {
      drag.target = ''; setDropRegionId(''); return;
    }
    const box = row.getBoundingClientRect();
    drag.target = row.dataset.regionId!;
    drag.placement = row.dataset.autoLast === 'true' || event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    setDropRegionId(drag.target);
    setDropPlacement(drag.placement);
  };
  const endRegionDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const drag = regionDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!cancelled) moveRegionDrag(event);
    regionDrag.current = null;
    if (drag.capture.hasPointerCapture(event.pointerId)) drag.capture.releasePointerCapture(event.pointerId);
    setDropRegionId('');
    setDraggedRegionId('');
    if (cancelled || !drag.target || drag.from === drag.target) return;
    updateScene(drag.sceneId, (scene) => {
      const moved = scene.regions.find((region) => region.id === drag.from);
      const target = scene.regions.find((region) => region.id === drag.target);
      if (!moved || !target || moved.locked || moved.isAutoLast || target.locked) return scene;
      const regions = scene.regions.filter((region) => region.id !== drag.from);
      const destination = regions.findIndex((region) => region.id === drag.target)
        + (drag.placement === 'after' && !target.isAutoLast ? 1 : 0);
      regions.splice(destination, 0, moved);
      return scheduleScene({...scene, regions});
    });
    setMessage('已更新出现顺序并重新排时。');
  };
  const clearRegions = () => {
    if (!scene || !scene.regions.length) return;
    stopEditingPlayback();
    updateScene(scene.id, (scene) => ({...scene, regions: []}));
    setSelectedRegionId('');
    setMessage('已清空当前图片的全部框选，可点击“撤销”恢复。');
  };
  const removeSelected = () => {
    if (!scene || !selected || selected.locked || busy) return;
    updateScene(scene.id, (scene) => ({...scene, regions: scene.regions.filter((region) => region.id !== selected.id)}));
    setSelectedRegionId('');
  };

  const startExport = () => void run('正在提交导出…', async () => {
    setPreparingExport(true);
    try {
      const exportProject = await prepareExportProject(project);
      const response = await fetch('/api/exports', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({project: exportProject, size: Number(exportSize), format: exportFormat})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '导出提交失败');
      setJob(result);
      setMessage(`正在本机生成 ${exportFormat.toUpperCase()}，本次导出使用提交时的项目。`);
    } finally {setPreparingExport(false);}
  });

  useEffect(() => {
    if (!job || !['queued', 'rendering', 'encoding'].includes(job.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/exports/${job.id}`, {signal: controller.signal});
        if (!response.ok) throw new Error('无法查询导出进度，请确认本地服务仍在运行');
        const next: ExportJob = await response.json();
        setJob(next);
        if (['queued', 'rendering', 'encoding'].includes(next.status)) timer = setTimeout(poll, 700);
      } catch (error) {
        if (!controller.signal.aborted) {setError(error instanceof Error ? error.message : '查询失败'); timer = setTimeout(poll, 2000);}
      }
    };
    timer = setTimeout(poll, 300);
    return () => {clearTimeout(timer); controller.abort();};
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job || job.status !== 'done' || downloadedJobs.current.has(job.id)) return;
    downloadedJobs.current.add(job.id);
    const link = document.createElement('a');
    link.href = `/api/exports/${job.id}/download`;
    link.download = `region-motion.${job.format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setMessage(`${job.format.toUpperCase()} 导出完成，已自动触发下载。`);
  }, [job?.id, job?.status, job?.format]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault();};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName) || target.isContentEditable || busy) return;
      if (event.code === 'Space') {event.preventDefault(); if (playback.playing) playback.pause(); else playback.play();}
      if (event.key === 'Escape') {playback.pause(); playback.setPreview(false);}
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected && !selected.locked) {event.preventDefault(); removeSelected();}
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); stopEditingPlayback(); setDirty(true); if (event.shiftKey) redo(); else undo();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">r<span>m</span></span><div><strong>Region Motion</strong><small>图片框选与动画工作台</small></div></div>
      <span className="local-badge">本地处理 · 无需 AI Key</span>
      <div className="header-actions">
        <button onClick={() => usageDialog.current?.showModal()}>使用说明</button>
        <button disabled={!!busy} onClick={() => projectInput.current?.click()}>打开项目</button>
        <button disabled={!!busy || !project.scenes.length} onClick={() => {
          try {downloadProject(project); setDirty(false); setError(''); setMessage('项目已下载，包含图片和全部编辑数据。');}
          catch (error) {setError((error as Error).message);}
        }}>保存项目{dirty ? ' ·' : ''}</button>
        <select className="header-format" aria-label="导出格式" value={exportFormat} disabled={exporting || !!busy}
          onChange={(event) => {const format = event.target.value as ExportFormat; setExportFormat(format); setExportSize(format === 'gif' ? '720' : '1080');}}>
          <option value="mp4">MP4</option><option value="gif">GIF</option></select>
        <button className="primary header-export" disabled={!!busy || exporting || !project.scenes.length} onClick={startExport}
          aria-live="polite" title={`导出 ${exportFormat.toUpperCase()}`}>
          {preparingExport || exporting ? `导出中 ${exportProgress}%`
            : job?.status === 'done' && job.format === exportFormat ? '已完成 100%' : `导出 ${exportFormat.toUpperCase()}`}
        </button>
      </div>
    </header>
    <input ref={imagesInput} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={importImages} />
    <input ref={projectInput} hidden type="file" accept=".json" onChange={importProject} />
    <div className="workspace">
      <aside className="scene-panel"><div className="panel-title"><h2>画面</h2><span>{project.scenes.length} / 30</span></div>
        <button className="add-image" disabled={!!busy} onClick={() => imagesInput.current?.click()}>＋ 上传图片并自动框选</button>
        <button className="load-examples" disabled={!!busy} onClick={loadExamples}>载入双图案例演示</button>
        <div className="scene-list">{project.scenes.map((item, index) => <button key={item.id} disabled={!!busy}
          className={`scene-card ${scene?.id === item.id ? 'active' : ''}`} onClick={() => selectScene(item)}>
          <div className="scene-thumb"><img src={item.imageUrl} alt={item.name} /><span>{String(index + 1).padStart(2, '0')}</span></div>
          <strong>{item.name}</strong><small>{item.duration.toFixed(1)} 秒 · {item.regions.length} 个区域</small>
        </button>)}</div>
        <div className="scene-footer"><label>项目名称<input maxLength={200} value={project.name} disabled={!!busy} onChange={(event) => edit({...project, name: event.target.value})} /></label>
          <p>保存为 JSON 后，可在另一台电脑恢复。素材不上传云端。</p></div>
      </aside>
      <main className="editor-main">
        <div className="toolbar"><div className="tool-group">{([
          ['select', '选择 / 移动'], ['rectangle', '矩形框选'], ['freehand', '自由圈选'], ['hide', '隐藏区域'],
        ] as const).map(([value, label]) => <button key={value} className={!playback.preview && tool === value ? 'active' : ''}
          disabled={!scene || !!busy} onClick={() => {stopEditingPlayback(); setTool(value);}}>{label}</button>)}</div>
          <div className="tool-group"><button disabled={!canUndo || !!busy} onClick={() => {stopEditingPlayback(); undo(); setDirty(true);}}>撤销</button>
            <button disabled={!canRedo || !!busy} onClick={() => {stopEditingPlayback(); redo(); setDirty(true);}}>重做</button></div></div>
        <div className="canvas-area">
          {scene ? <div className="canvas-scroll" ref={canvasViewport}><div className="canvas-sizing" style={{width: canvasWidth, height: canvasHeight}}>
            <div className="stage" style={{backgroundColor: scene.backgroundColor}}>
              {playback.preview && sceneIndex > 0 ? <AnimatedPreviousSceneFrame enabled incomingScene={scene}
                previousScene={project.scenes[sceneIndex - 1]} previousSceneIndex={sceneIndex - 1}
                store={playback.store} style={{...fullFrameStyle, backgroundColor: previousScene?.backgroundColor}} contentStyle={previousFrameStyle} /> : null}
              <AnimatedSceneFrame enabled={playback.preview} hasPrevious={sceneIndex > 0} scene={scene} sceneIndex={sceneIndex}
                store={playback.store} style={fullFrameStyle}>
                <div style={imageFrameStyle}>
                <img className="j-main-image" src={scene.imageUrl} alt={scene.name} draggable={false} />
                {playback.preview ? <div className="j-image-overlay"><AnimatedRegionLayers store={playback.store} scene={scene} /></div>
                  : <SelectionCanvas key={scene.id} scene={scene} selectedId={selectedRegionId} tool={tool} onSelect={setSelectedRegionId}
                    onAdd={(region) => {
                      if (busy) return;
                      if (scene.regions.length >= MAX_REGIONS) {setError('每张图片最多支持 100 个区域'); return;}
                      updateScene(scene.id, (scene) => addRegions(scene, [region]));
                      setSelectedRegionId(region.id);
                    }} onCommit={(region) => {if (!busy) updateScene(scene.id, (scene) => ({...scene, regions: scene.regions.map((item) => item.id === region.id ? region : item)}));}} />}
                </div>
              </AnimatedSceneFrame>
            </div>
          </div></div> : <div className="empty-state"><span className="empty-corners">▧</span><p className="eyebrow">FROM STILL TO STORY</p>
            <h1>让图片里的元素，<br />按你的节奏出现。</h1><p>上传图片自动框选，调整区域、安排动画，<br />预览后直接导出视频。</p>
            <div className="empty-actions"><button className="primary large" disabled={!!busy} onClick={() => imagesInput.current?.click()}>上传第一张图片</button>
              <button className="large" disabled={!!busy} onClick={loadExamples}>先看双图演示</button></div>
            <small>PNG / JPEG / WebP · 单张最多 20 MB</small>
            <div className="example-thumbnails">{EXAMPLE_IMAGES.map((example) => <figure key={example.file}>
              <img src={`./examples/${example.file}`} alt={example.title} loading="lazy" /><figcaption>{example.title}</figcaption>
            </figure>)}</div></div>}
        </div>
        <div className="canvas-meta"><span>{scene ? `${scene.width} × ${scene.height} · ${playback.preview ? '动画预览' : '编辑选区'}` : '准备开始'}</span>
          <label>缩放 <select aria-label="画布缩放" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{[75, 100, 125, 150, 200].map((value) => <option key={value} value={value}>{value}%</option>)}</select></label>
          <button disabled={!scene} onClick={() => {playback.pause(); playback.setPreview(!playback.preview);}}>切换{playback.preview ? '编辑' : '预览'}</button></div>
        <PlaybackControls store={playback.store} total={playback.total} playing={playback.playing} onSeek={(time) => {playback.setPreview(true); playback.seek(time);}}
          onToggle={() => {if (playback.playing) playback.pause(); else playback.play();}} />
        <div className="status-bar" role="status">{busy || message}</div>
        {error ? <div className="error-message" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div> : null}
        {job ? <div className="export-status" aria-live="polite"><span>{({queued: '准备导出', rendering: '渲染画面', encoding: '编码视频', done: '导出完成', error: '导出失败', cancelled: '已取消'})[job.status]}</span>
          <progress max="100" value={job.progress} /><span>{Math.round(job.progress)}%</span>
          {exporting ? <button onClick={() => void run('正在取消…', async () => {
            const response = await fetch(`/api/exports/${job.id}`, {method: 'DELETE'});
            const result = await response.json(); if (!response.ok) throw new Error(result.error); setJob(result);
          })}>取消</button> : null}
          {job.status === 'done' ? <><span>已自动触发下载</span><a href={`/api/exports/${job.id}/download`} download={`region-motion.${job.format}`}>重新下载</a></> : null}
          {job.error ? <span className="error-text">{job.error}</span> : null}
        </div> : null}
      </main>
      <aside className="properties-panel"><div className="panel-title"><h2>区域与动画</h2><span>{scene?.regions.length ?? 0}</span></div>
        <fieldset disabled={!scene || !!busy}>
          <label className="detection-count">目标内容区域数<input type="number" min="1" max="50" placeholder="留空：自动识别，与原项目默认一致" value={preferredRegionCount}
            onChange={(event) => setPreferredRegionCount(event.target.value === '' ? '' : String(clamp(Math.round(Number(event.target.value)), 1, 50)))} /></label>
          <div className="property-actions"><button onClick={detect}>重新自动框选</button><button onClick={() => {if (scene) updateScene(scene.id, scheduleScene);}}>自动排时</button>
            <button className="danger" disabled={!scene?.regions.length} onClick={clearRegions}>清空框选</button></div>
          <p className="reorder-hint">按住整条区域记录上下拖动，松开调整出现顺序。</p>
          <div className="region-list">{scene?.regions.map((region, index) => <div key={region.id}
            data-region-id={region.id} data-locked={region.locked} data-auto-last={region.isAutoLast === true}
            className={`region-row ${region.id === selectedRegionId ? 'selected' : ''} ${region.id === draggedRegionId ? 'dragging' : ''} ${region.id === dropRegionId ? `drop-${dropPlacement}` : ''}`}
              title={region.isAutoLast ? '整图末位固定在最后' : '按住整条区域记录上下拖动调整顺序'} onPointerDown={(event) => beginRegionDrag(event, region)}
              onPointerMove={moveRegionDrag} onPointerUp={(event) => endRegionDrag(event)}
              onPointerCancel={(event) => endRegionDrag(event, true)} onLostPointerCapture={(event) => endRegionDrag(event, true)}>
            <span className="drag-grip" aria-hidden="true">⠿</span>
            <button className="region-name" onClick={() => {stopEditingPlayback(); setSelectedSceneId(scene.id); setSelectedRegionId(region.id);}}><span>{region.alwaysHidden ? '×' : index + 1}</span><strong>{region.name}</strong><small>{region.isAutoLast ? '整图末位' : region.locked ? '锁定' : region.effect}</small></button>
            <button data-order-action aria-label="提前出现" disabled={index === 0 || region.locked || region.isAutoLast} onClick={() => moveOrder(index, -1)}>↑</button>
            <button data-order-action aria-label="推后出现" disabled={index === scene.regions.length - 1 || region.locked || region.isAutoLast || scene.regions[index + 1]?.isAutoLast} onClick={() => moveOrder(index, 1)}>↓</button>
          </div>)}</div>
          {selected ? <div className="region-properties"><label>区域名称<input maxLength={200} disabled={selected.locked} value={selected.name} onChange={(event) => updateRegion({name: event.target.value})} /></label>
            <label>动画效果<select disabled={selected.locked || selected.alwaysHidden} value={selected.effect} onChange={(event) => updateRegion({effect: event.target.value as RegionEffect})}>{effects.map((effect) => <option key={effect.value} value={effect.value}>{effect.label}</option>)}</select></label>
            {selected.effect === 'wipe' ? <label>揭示方向<select disabled={selected.locked} value={selected.direction} onChange={(event) => updateRegion({direction: event.target.value as IllustrationRegion['direction']})}>
              {([['left-to-right', '从左到右'], ['right-to-left', '从右到左'], ['top-to-bottom', '从上到下'], ['bottom-to-top', '从下到上'], ['top-left-to-bottom-right', '左上至右下'], ['bottom-left-to-top-right', '左下至右上']] as const)
                .map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
            <div className="two-columns"><label>开始 / 秒<input type="number" min="0" max={scene?.duration} step="0.1" disabled={selected.locked} value={Number((selected.startTime - scene!.startTime).toFixed(2))}
              onChange={(event) => updateRegion({startTime: scene!.startTime + clamp(Number(event.target.value), 0, scene!.duration - 0.05)})} /></label>
              <label>持续 / 秒<input type="number" min="0.05" max={scene?.duration} step="0.05" disabled={selected.locked} value={selected.duration}
                onChange={(event) => updateRegion({duration: clamp(Number(event.target.value), 0.05, scene!.duration)})} /></label></div>
            {([['initialVisible', '播放前已显示'], ['keepVisible', '动画后保持'], ['alwaysHidden', '始终隐藏这块内容'], ['visible', '启用该区域']] as const).map(([key, label]) => <label className="checkbox" key={key}>
              <input type="checkbox" checked={selected[key]} disabled={selected.locked} onChange={(event) => updateRegion({[key]: event.target.checked})} />{label}</label>)}
            <div className="property-actions"><button onClick={() => {if (scene) updateScene(scene.id, (scene) => ({...scene, regions: scene.regions.map((region) => region.id === selected.id ? {...region, locked: !region.locked} : region)}));}}>{selected.locked ? '解锁区域' : '锁定区域'}</button>
              <button className="danger" disabled={selected.locked} onClick={removeSelected}>删除区域</button></div>
          </div> : <p className="hint">上下拖动列表区域调整出现顺序；选择工具可移动画布选区和边界。整图末位区域固定在最后。</p>}
          {scene ? <section className="scene-properties"><h3>当前画面</h3><label>背景遮罩色<input type="color" value={scene.backgroundColor} onChange={(event) => updateScene(scene.id, (scene) => ({...scene, backgroundColor: event.target.value}))} /></label>
            <div className="two-columns"><label>时长 / 秒<input type="number" min="0.5" max="3600" step="0.5" value={scene.duration} onChange={(event) => updateScene(scene.id, (scene) => scheduleScene({...scene,
              duration: clamp(Number(event.target.value), 0.5, 3600)}))} /></label>
              <label>入场转场<select value={scene.transition} onChange={(event) => updateScene(scene.id, (scene) => ({...scene, transition: event.target.value as IllustrationScene['transition']}))}>
                <option value="cut">直接切换</option><option value="fade">淡入</option><option value="push-left">向左推入</option><option value="push-right">向右推入</option><option value="zoom">缩放</option></select></label></div>
            <button className="danger" onClick={() => {edit({...project, scenes: arrangeScenes(project.scenes.filter((item) => item.id !== scene.id))}); setSelectedSceneId(''); setSelectedRegionId('');}}>删除当前画面</button>
          </section> : null}
        </fieldset>
        <section className="export-options"><h3>视频导出</h3><label>长边分辨率<select value={exportSize} disabled={exporting} onChange={(event) => setExportSize(event.target.value)}><option value="720">720 px · 快速</option><option value="1080">1080 px · 标准</option><option value="1920">1920 px · 高清</option></select></label>
          <p>{exportFormat === 'gif' ? 'GIF · 15 fps · 循环播放，建议使用 720 px。' : 'MP4 · 30 fps · 无声音轨。'}保留区域动画与转场，画幅跟随第一张图片。</p></section>
      </aside>
    </div>
    <dialog ref={usageDialog} className="usage-dialog">
      <div className="usage-title"><h2>图片变动画，怎么使用？</h2><button onClick={() => usageDialog.current?.close()}>关闭</button></div>
      <p>不需要 AI Key。先载入案例熟悉流程，再换成自己的图片。</p>
      <ol className="usage-steps">
        <li><strong>载入图片：</strong>点击“载入双图案例演示”，或上传自己的 PNG、JPEG、WebP。案例追加到现有项目，上传后自动框选。</li>
        <li><strong>修改框选：</strong>在右侧点选区域，拖动蓝色控制点调整边界；也可以使用矩形框选、自由圈选补画，或用“隐藏区域”遮住内容。</li>
        <li><strong>调整顺序：</strong>按住整条区域记录上下拖动，到插入线位置后松开，不需要先选中或对准手柄。整图末位固定在最后，手动补框排在它之前。</li>
        <li><strong>设置动画：</strong>选择淡入、轻弹、滑入或擦除，设置开始与持续时间。清空、删除或改错都可以撤销。</li>
        <li><strong>播放预览：</strong>点击下方“播放”或按空格；拖动进度条定位，按 Esc 返回编辑。100% 缩放自动适配窗口。</li>
        <li><strong>导出成品：</strong>右上角选 MP4 或 GIF，再点导出。按钮显示百分比，完成后自动下载；下方“重新下载”仅用于再次获取成品。</li>
        <li><strong>保留编辑：</strong>点击“保存项目”下载 JSON。下次点击“打开项目”恢复图片、选区和动画；导出成品不能替代项目文件。</li>
      </ol>
      <div className="usage-examples">{EXAMPLE_IMAGES.map((example) => <figure key={example.file}>
        <img src={`./examples/${example.file}`} alt={example.title} loading="lazy" /><figcaption><strong>{example.title}</strong><span>{example.description}</span></figcaption>
      </figure>)}</div>
      <p className="usage-license">代码与文档采用 <a href="./LICENSE.txt" target="_blank" rel="noreferrer">MIT 开源协议</a>。</p>
    </dialog>
  </div>;
}
