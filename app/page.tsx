'use client';

import { useEffect, useRef, useState } from 'react';

type StyleBrief = {
  category: string;
  category_other: string;
  purpose: string;
  tone: string;
  formality: string;
  caption_mode: string;
  caption_density: string;
  caption_language: string;
  topic_keywords: string[];
  avoid_phrases: string[];
  must_include_phrases: string[];
  extra_notes: string;
};
const DEFAULT_BRIEF: StyleBrief = {
  category: '', category_other: '', purpose: '', tone: '', formality: '',
  caption_mode: '', caption_density: '', caption_language: '', topic_keywords: [],
  avoid_phrases: [], must_include_phrases: [], extra_notes: '',
};

type TtsConfig = {
  enabled: boolean;
  mode: 'captions' | 'script';  // outline 생성 시 LLM 에게 어떤 소스를 우선시할지 힌트로만 사용
  voice: string;
  script: string;                // mode=script 일 때 LLM 에게 추가로 줄 사용자 대본
};
const DEFAULT_TTS: TtsConfig = {
  enabled: false, mode: 'captions', voice: 'Kore', script: '',
};

type NarrationSegment = {
  cut_index: number;
  output_start: number;
  output_end: number;
  text: string;
};
type TtsOutline = {
  generated_at: string | null;
  generated_model: string;
  total_duration: number;
  segments: NarrationSegment[];
  approved: boolean;
  approved_at: string | null;
  last_synthesis: { at: string; notes: string[] } | null;
};
const DEFAULT_OUTLINE: TtsOutline = {
  generated_at: null, generated_model: '', total_duration: 0,
  segments: [], approved: false, approved_at: null, last_synthesis: null,
};
const TTS_VOICE_OPTS: { v: string; label: string }[] = [
  { v: 'Kore',   label: 'Kore — 차분/명료 (한국어 권장)' },
  { v: 'Puck',   label: 'Puck — 발랄/명랑' },
  { v: 'Charon', label: 'Charon — 깊고 묵직 (남성)' },
  { v: 'Aoede',  label: 'Aoede — 부드러움' },
  { v: 'Fenrir', label: 'Fenrir — 강하고 단단' },
  { v: 'Leda',   label: 'Leda — 차분 여성' },
  { v: 'Orus',   label: 'Orus — 중후 남성' },
  { v: 'Zephyr', label: 'Zephyr — 가볍고 빠른' },
];

type ProjectState = {
  ok: true;
  projectId: string;
  styleNote: string;
  styleBrief: StyleBrief;
  ttsConfig: TtsConfig;
  ttsOutline: TtsOutline;
  ttsOutlineIssues: string[];
  uploads: { reference: string[]; sources: string[]; bgm: string[] };
  stages: {
    s0_spec: boolean;
    s1_cut: boolean;
    s2_graded: boolean;
    s3_captioned: boolean;
    s4_final: boolean;
  };
  artifacts: {
    editSpec: any | null;
    editPlan: any | null;
    colorStats: any | null;
  };
  paths: {
    finalMp4: string | null;
    captionedMp4: string | null;
    gradedMp4: string | null;
    cutMp4: string | null;
  };
};

const STAGE_INFO: { id: 0 | 1 | 2 | 3 | 4; title: string; desc: string; eta: string }[] = [
  { id: 0, title: 'Stage 0 — 레퍼런스 분석', desc: 'Gemini Pro 가 레퍼런스 영상을 컷/색감/오디오 스펙으로 분해', eta: '약 1~3분' },
  { id: 1, title: 'Stage 1 — 컷편집', desc: 'FFmpeg 컷검출 + Gemini Flash 묘사 + OpenAI 임베딩 매칭 → 9:16 컷 영상', eta: '소스 1개당 약 1~2분' },
  { id: 2, title: 'Stage 2 — 영상 보정', desc: 'FFmpeg signalstats 로 색감 측정 후 차이를 eq/colorbalance 로 보정', eta: '약 10~30초' },
  { id: 3, title: 'Stage 3 — 자막', desc: '스펙의 캡션 텍스트를 ASS 자막으로 burn-in', eta: '약 10~30초' },
  { id: 4, title: 'Stage 4 — 음성/BGM', desc: 'BGM 업로드 있으면 사용. 없으면 Stage 0 의 bgm_mood 로 Internet Archive 에서 자동 다운로드 후 sidechain ducking 으로 믹스.', eta: '약 10~60초' },
];

export default function Page() {
  const [projectId, setProjectId] = useState<string>('');
  const [state, setState] = useState<ProjectState | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [busyStage, setBusyStage] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [err, setErr] = useState<string>('');
  const [log, setLog] = useState<string[]>([]);
  const [styleNote, setStyleNote] = useState<string>('');
  const [styleNoteSaving, setStyleNoteSaving] = useState(false);
  const [brief, setBrief] = useState<StyleBrief>(DEFAULT_BRIEF);
  const [briefSaving, setBriefSaving] = useState(false);
  const briefSaveTimer = useRef<number | null>(null);
  const [tts, setTts] = useState<TtsConfig>(DEFAULT_TTS);
  const [ttsSaving, setTtsSaving] = useState(false);
  const ttsSaveTimer = useRef<number | null>(null);
  const [outline, setOutline] = useState<TtsOutline>(DEFAULT_OUTLINE);
  const [outlineIssues, setOutlineIssues] = useState<string[]>([]);
  const [outlineBusy, setOutlineBusy] = useState<'' | 'generating' | 'saving' | 'confirming'>('');
  const [replanFeedback, setReplanFeedback] = useState<string>('');
  const [replanning, setReplanning] = useState<boolean>(false);
  // ----- IG 자동 파이프라인 -----
  const [autoRefMode, setAutoRefMode] = useState<'url' | 'file'>('url');
  const [autoRefUrl, setAutoRefUrl] = useState<string>('');
  const [autoRefFile, setAutoRefFile] = useState<File | null>(null);
  const [autoSourceFiles, setAutoSourceFiles] = useState<File[]>([]);
  const [autoRunning, setAutoRunning] = useState<boolean>(false);
  const [autoSteps, setAutoSteps] = useState<{ step: string; msg: string; t: number }[]>([]);
  const autoAbortRef = useRef<AbortController | null>(null);
  // 새 stage 결과를 받을 때마다 영상 URL 에 붙이는 캐시 버스터.
  // 같은 경로의 파일이 재생성돼도 브라우저가 옛 영상 들고 있는 문제 방지.
  const [cacheBust, setCacheBust] = useState<number>(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const styleSyncedRef = useRef<string>('');

  const appendLog = (s: string) => {
    const t = new Date().toLocaleTimeString();
    setLog(prev => [...prev.slice(-100), `[${t}] ${s}`]);
  };

  // ----- 알림 권한 -----
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // ----- 경과 시간 타이머 -----
  useEffect(() => {
    if (!busy) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setElapsedSec(0);
      return;
    }
    startRef.current = Date.now();
    setElapsedSec(0);
    timerRef.current = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); } };
  }, [busy]);

  // ----- 상태 조회 -----
  const refresh = async (pid = projectId) => {
    if (!pid) return;
    const res = await fetch(`/api/project?projectId=${encodeURIComponent(pid)}`);
    const j = await res.json();
    if (j.ok) {
      setState(j);
      setCacheBust(Date.now()); // 새로고침 시점 기준으로 영상 URL 갱신
    } else setErr(j.error || '상태 조회 실패');
  };

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('projectId') : '';
    if (saved) { setProjectId(saved); refresh(saved); }
  }, []);

  useEffect(() => {
    if (projectId) localStorage.setItem('projectId', projectId);
  }, [projectId]);

  // 서버 저장값을 로컬 state 에 동기화. 같은 projectId 는 한 번만.
  useEffect(() => {
    if (state?.projectId && state.projectId !== styleSyncedRef.current) {
      setStyleNote(state.styleNote || '');
      setBrief({ ...DEFAULT_BRIEF, ...(state.styleBrief || {}) });
      setTts({ ...DEFAULT_TTS, ...(state.ttsConfig || {}) });
      setOutline({ ...DEFAULT_OUTLINE, ...(state.ttsOutline || {}) });
      setOutlineIssues(state.ttsOutlineIssues || []);
      styleSyncedRef.current = state.projectId;
    }
  }, [state]);

  // 브리프 자동 저장 (300ms debounce)
  const saveBrief = async (next: StyleBrief) => {
    if (!projectId) return;
    setBriefSaving(true);
    try {
      await fetch('/api/style-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, brief: next }),
      });
    } catch {} finally { setBriefSaving(false); }
  };
  const updateBrief = (patch: Partial<StyleBrief>) => {
    const next = { ...brief, ...patch };
    setBrief(next);
    if (briefSaveTimer.current) clearTimeout(briefSaveTimer.current);
    briefSaveTimer.current = window.setTimeout(() => saveBrief(next), 300);
  };

  // ----- TTS 설정 자동 저장 (300ms debounce) -----
  const saveTts = async (next: TtsConfig) => {
    if (!projectId) return;
    setTtsSaving(true);
    try {
      await fetch('/api/tts-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, tts: next }),
      });
    } catch {} finally { setTtsSaving(false); }
  };
  const updateTts = (patch: Partial<TtsConfig>) => {
    const next = { ...tts, ...patch };
    setTts(next);
    if (ttsSaveTimer.current) clearTimeout(ttsSaveTimer.current);
    ttsSaveTimer.current = window.setTimeout(() => saveTts(next), 300);
  };

  // ----- 나레이션 개요 (TTS 합성 전 confirm 단계) -----
  const generateOutline = async () => {
    if (!projectId) { setErr('먼저 프로젝트를 만드세요'); return; }
    if (!state?.stages.s1_cut) { setErr('Stage 1 (컷편집) 먼저 실행해야 개요를 만들 수 있습니다'); return; }
    setErr(''); setOutlineBusy('generating');
    appendLog('▶ 나레이션 개요 생성');
    try {
      const res = await fetch('/api/tts-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      setOutline(j.outline);
      setOutlineIssues(j.issues || []);
      appendLog(`✓ 개요 ${j.outline.segments.length}개 segment 생성. 검토 후 "확인하고 진행" 을 눌러주세요.`);
    } catch (e: any) {
      setErr(e.message);
      appendLog(`✗ 개요 생성 실패: ${e.message}`);
    } finally { setOutlineBusy(''); }
  };
  const patchOutline = async (patch: { segments?: NarrationSegment[]; approved?: boolean }) => {
    if (!projectId) return;
    setOutlineBusy(typeof patch.approved === 'boolean' ? 'confirming' : 'saving');
    try {
      const res = await fetch('/api/tts-outline', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...patch }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      setOutline(j.outline);
      setOutlineIssues(j.issues || []);
    } catch (e: any) {
      setErr(e.message);
    } finally { setOutlineBusy(''); }
  };
  const updateSegmentText = (idx: number, text: string) => {
    const nextSegs = outline.segments.map((s, i) => i === idx ? { ...s, text } : s);
    setOutline({ ...outline, segments: nextSegs, approved: false }); // 편집 시 자동으로 unapprove
    // debounce 처리는 단순히 두자 — 한 번 PATCH 로 묶어 보낸다.
  };
  const commitOutlineEdits = () => patchOutline({ segments: outline.segments, approved: false });
  const removeSegment = (idx: number) => {
    const nextSegs = outline.segments.filter((_, i) => i !== idx);
    setOutline({ ...outline, segments: nextSegs, approved: false });
    patchOutline({ segments: nextSegs, approved: false });
  };

  const replanCaptions = async () => {
    if (!projectId) { setErr('먼저 프로젝트를 만드세요'); return; }
    if (!state?.stages.s1_cut) { setErr('Stage 1 먼저 실행하세요'); return; }
    setErr(''); setReplanning(true); setBusy('자막 재생성 중'); setBusyStage(3);
    appendLog(`▶ 자막 재생성 시작 (feedback=${replanFeedback ? '있음' : '없음'})`);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/replan-captions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, feedback: replanFeedback }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const dur = Math.floor((Date.now() - startRef.current) / 1000);
      appendLog(`✓ 자막 재생성 완료 (${fmtElapsed(dur)}): layer ${j.total_layers}개, 자막 있는 컷 ${j.cuts_with_caption}`);
      notifyComplete('자막 재생성 완료', `${j.total_layers} layer`);
      await refresh();
    } catch (e: any) {
      if (e.name === 'AbortError') appendLog('⛔ 자막 재생성 중단됨 (UI)');
      else { setErr(e.message); appendLog(`✗ 자막 재생성 실패: ${e.message}`); }
    } finally {
      abortRef.current = null;
      setReplanning(false); setBusy(''); setBusyStage(null);
    }
  };

  const saveStyleNote = async () => {
    if (!projectId) return;
    setStyleNoteSaving(true);
    try {
      const res = await fetch('/api/style-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, text: styleNote }),
      });
      const j = await res.json();
      if (j.ok) appendLog(`스타일 노트 저장 (${j.length}자)`);
    } catch (e: any) {
      setErr(`스타일 노트 저장 실패: ${e.message}`);
    } finally { setStyleNoteSaving(false); }
  };

  // ----- 액션들 -----
  const createProject = async () => {
    setErr(''); setBusy('프로젝트 생성 중'); setBusyStage(null);
    try {
      const res = await fetch('/api/create-project', { method: 'POST' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      setProjectId(j.projectId);
      appendLog(`프로젝트 생성: ${j.projectId}`);
      await refresh(j.projectId);
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); setBusyStage(null); }
  };

  // ----- IG 자동 파이프라인 (ig-fetch → create → Stage 0 → Stage 1) -----
  const cancelAutoPipeline = () => {
    if (autoAbortRef.current) autoAbortRef.current.abort();
  };

  const runAutoPipeline = async () => {
    const refUrl = autoRefUrl.trim();

    if (autoRefMode === 'url' && !refUrl) {
      setErr('레퍼런스 IG URL 을 입력하세요');
      return;
    }
    if (autoRefMode === 'file' && !autoRefFile) {
      setErr('레퍼런스 파일을 선택하세요');
      return;
    }
    if (autoSourceFiles.length === 0) {
      setErr('소스 파일을 1개 이상 선택하세요');
      return;
    }

    setErr('');
    setAutoRunning(true);
    setAutoSteps([]);
    setBusy('자동 파이프라인 실행 중');
    setBusyStage(null);
    appendLog(
      `▶ 자동 파이프라인 시작 (ref=${autoRefMode}, sources=${autoSourceFiles.length}개)`,
    );

    const ctrl = new AbortController();
    autoAbortRef.current = ctrl;

    try {
      const fd = new FormData();
      if (autoRefMode === 'url') {
        fd.append('referenceUrl', refUrl);
      } else if (autoRefFile) {
        fd.append('referenceFile', autoRefFile, autoRefFile.name);
      }
      for (const f of autoSourceFiles) {
        fd.append('sourceFiles', f, f.name);
      }
      if (styleNote) fd.append('styleNote', styleNote);

      const res = await fetch('/api/auto-pipeline', {
        method: 'POST',
        body: fd,
        signal: ctrl.signal,
      });

      if (!res.ok && !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(`자동 파이프라인 시작 실패 (${res.status}): ${t}`);
      }
      if (!res.body) throw new Error('응답 body 없음');

      // SSE 파싱: \n\n 로 끊어진 event 블록을 순차 처리
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let resultProjectId = '';
      let finalError = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evt = parseSseBlock(block);
          if (!evt) continue;

          if (evt.event === 'progress') {
            const step = String(evt.data.step || '');
            const msg = String(evt.data.msg || '');
            setAutoSteps(prev => [...prev, { step, msg, t: Date.now() }]);
            appendLog(`  · ${msg}`);
            // 새 projectId 가 progress 로 먼저 들어옴 — 즉시 UI 활성화
            if (step === 'create_project' && evt.data.projectId) {
              setProjectId(evt.data.projectId);
            }
          } else if (evt.event === 'done') {
            resultProjectId = String(evt.data.projectId || '');
          } else if (evt.event === 'error') {
            finalError = String(evt.data.error || '알 수 없는 에러');
            if (evt.data.projectId) resultProjectId = String(evt.data.projectId);
          }
        }
      }

      if (finalError) throw new Error(finalError);
      if (!resultProjectId) throw new Error('서버가 projectId 를 반환하지 않음');

      setProjectId(resultProjectId);
      await refresh(resultProjectId);
      const dur = Math.floor((Date.now() - startRef.current) / 1000);
      appendLog(`✓ 자동 파이프라인 완료 (${fmtElapsed(dur)}): Stage 0~1 까지. 이후 Stage 2~4 는 수동 실행.`);
      notifyComplete('자동 파이프라인 완료', `Stage 0~1 / ${fmtElapsed(dur)}`);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        appendLog('⛔ 자동 파이프라인 중단됨 (UI). 서버 작업은 백그라운드에서 계속될 수 있습니다.');
      } else {
        setErr(e.message || String(e));
        appendLog(`✗ 자동 파이프라인 실패: ${e.message || e}`);
        notifyComplete('자동 파이프라인 실패', String(e.message || e).slice(0, 100));
      }
    } finally {
      autoAbortRef.current = null;
      setAutoRunning(false);
      setBusy('');
      setBusyStage(null);
    }
  };

  const upload = async (kind: 'reference' | 'source' | 'bgm', files: FileList | null) => {
    if (!projectId) { setErr('먼저 프로젝트를 만드세요'); return; }
    if (!files || files.length === 0) return;
    setErr(''); setBusy(`${kind} 업로드 중`); setBusyStage(null);
    try {
      const fd = new FormData();
      fd.append('projectId', projectId);
      fd.append('kind', kind);
      for (const f of Array.from(files)) fd.append('file', f);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      appendLog(`${kind} 업로드: ${(j.saved as string[]).join(', ')}`);
      await refresh();
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); setBusyStage(null); }
  };

  const runStage = async (stage: 0 | 1 | 2 | 3 | 4): Promise<boolean> => {
    if (!projectId) { setErr('먼저 프로젝트를 만드세요'); return false; }
    setErr('');
    setBusy(`Stage ${stage} 실행 중`);
    setBusyStage(stage);
    appendLog(`▶ Stage ${stage} 시작 (${STAGE_INFO[stage].eta})`);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let ok = false;
    try {
      const res = await fetch('/api/run-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, stage }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const dur = Math.floor((Date.now() - startRef.current) / 1000);
      appendLog(`✓ Stage ${stage} 완료 (${fmtElapsed(dur)}): ${summarizeResult(j)}`);
      notifyComplete(`Stage ${stage} 완료`, `소요 ${fmtElapsed(dur)}`);
      await refresh();
      ok = true;
    } catch (e: any) {
      if (e.name === 'AbortError') {
        appendLog(`⛔ Stage ${stage} 중단됨 (UI). 서버 작업은 백그라운드에서 계속될 수 있음 — 잠시 후 새로고침으로 확인하세요.`);
      } else {
        setErr(e.message);
        appendLog(`✗ Stage ${stage} 실패: ${e.message}`);
        notifyComplete(`Stage ${stage} 실패`, e.message.slice(0, 100));
      }
    } finally {
      abortRef.current = null;
      setBusy('');
      setBusyStage(null);
    }
    return ok;
  };

  // ----- Stage 0 → 4 전체 자동 실행 -----
  // **무조건 처음부터 끝까지** 실행 (이미 완료된 단계도 다시 돌림).
  // TTS enabled 면 Stage 4 직전에 나레이션 개요 자동 생성 + 자동 확정.
  // (사용자 확정 단계는 건너뜀 — 결과 마음에 안 들면 Stage 4 만 따로 다시 돌리면 됨)
  const runAll = async () => {
    if (!projectId) { setErr('먼저 프로젝트를 만드세요'); return; }
    if (busy) { setErr('다른 작업이 진행 중입니다'); return; }
    setErr('');
    appendLog('▶ 전체 자동 실행 시작 (Stage 0 → 4, 모든 단계 처음부터)');

    const fetchLatest = async (): Promise<any> => {
      try {
        const r = await fetch(`/api/project?projectId=${projectId}`);
        const j = await r.json();
        return j?.ok ? j : null;
      } catch { return null; }
    };

    for (const s of [0, 1, 2, 3, 4] as const) {
      // Stage 4 직전 — TTS enabled 이면 outline 자동 생성 + 자동 확정
      if (s === 4) {
        const latest = (await fetchLatest()) || state;
        if (latest?.ttsConfig?.enabled && !latest?.ttsOutline?.approved) {
          if (!latest?.ttsOutline?.generated_at) {
            appendLog('▶ 나레이션 개요 자동 생성');
            await generateOutline();
          }
          appendLog('▶ 나레이션 개요 자동 확정 (한 번에 실행 모드)');
          try {
            await fetch('/api/tts-outline', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId, approved: true }),
            });
          } catch (e: any) {
            appendLog(`✗ 개요 자동 확정 실패: ${e?.message || e}`);
            return;
          }
        }
      }

      const ok = await runStage(s);
      if (!ok) {
        appendLog(`⛔ Stage ${s} 실패로 전체 실행 중단`);
        return;
      }
    }

    appendLog('✅ 전체 자동 실행 완료 (Stage 0 → 4)');
    notifyComplete('전체 자동 실행 완료', 'Stage 0 → 4');
  };

  const cancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  };

  // ----- 조건 -----
  const refOk = (state?.uploads.reference.length ?? 0) > 0;
  const srcOk = (state?.uploads.sources.length ?? 0) > 0;

  const canRun = (stage: 0 | 1 | 2 | 3 | 4): { ok: boolean; reason: string } => {
    if (!state) return { ok: false, reason: '상태 없음' };
    if (stage === 0) return refOk ? { ok: true, reason: '' } : { ok: false, reason: '레퍼런스 영상 필요' };
    if (stage === 1) {
      if (!state.stages.s0_spec) return { ok: false, reason: 'Stage 0 먼저' };
      if (!srcOk) return { ok: false, reason: '소스 영상 필요' };
      return { ok: true, reason: '' };
    }
    if (stage === 2) return state.stages.s1_cut ? { ok: true, reason: '' } : { ok: false, reason: 'Stage 1 먼저' };
    if (stage === 3) return state.stages.s2_graded ? { ok: true, reason: '' } : { ok: false, reason: 'Stage 2 먼저' };
    if (stage === 4) {
      if (!state.stages.s3_captioned) return { ok: false, reason: 'Stage 3 먼저' };
      // TTS 활성이면 outline 확정 필수 (서버에서도 거부하지만 UI 에서 미리 차단).
      if (state.ttsConfig?.enabled && !state.ttsOutline?.approved) {
        return { ok: false, reason: 'TTS 활성: 위의 나레이션 개요를 확정해야 진행 가능' };
      }
      return { ok: true, reason: '' };
    }
    return { ok: false, reason: '' };
  };

  const stageDone = (stage: 0 | 1 | 2 | 3 | 4): boolean => {
    if (!state) return false;
    return [state.stages.s0_spec, state.stages.s1_cut, state.stages.s2_graded, state.stages.s3_captioned, state.stages.s4_final][stage];
  };

  const previewSrcForStage = (stage: 0 | 1 | 2 | 3 | 4): string | null => {
    if (!state) return null;
    const p = state.paths;
    const map = [null, p.cutMp4, p.gradedMp4, p.captionedMp4, p.finalMp4][stage];
    return map ? `/api/file?path=${encodeURIComponent(map)}&_=${cacheBust}` : null;
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 4 }}>Posty Prototype</h1>
      <div style={{ color: '#666', marginBottom: 20 }}>
        레퍼런스 릴스 1개 + 원본 영상 여러 개 → 단계별로 분석/편집/보정/자막/음성 적용.
      </div>

      {/* 진행 상태 (sticky) */}
      {busy && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: '#fffbe6', border: '1px solid #f0d27a', borderRadius: 6,
          padding: '10px 14px', marginBottom: 12, fontSize: 14,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span>⏳ {busy}…</span>
          <span style={{ fontFamily: 'monospace' }}>{fmtElapsed(elapsedSec)}</span>
          {busyStage !== null && (
            <span style={{ color: '#777' }}>예상 {STAGE_INFO[busyStage].eta}</span>
          )}
          <button onClick={cancel} style={{ marginLeft: 'auto', background: '#fee', borderColor: '#e88' }}>
            중단
          </button>
        </div>
      )}

      {/* 프로젝트 */}
      <Section title="프로젝트">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={createProject} disabled={!!busy}>새 프로젝트 만들기</button>
          <span style={{ fontFamily: 'monospace' }}>{projectId || '(없음)'}</span>
          {projectId && <button onClick={() => refresh()} disabled={!!busy}>새로고침</button>}
          {projectId && (
            <button onClick={() => { localStorage.removeItem('projectId'); setProjectId(''); setState(null); }}>
              초기화 (id 만 비움)
            </button>
          )}
        </div>
      </Section>

      {/* 자동 파이프라인 — 레퍼런스(IG URL/파일) + 소스(로컬 파일) */}
      <Section title="🚀 자동 시작 (레퍼런스 → 프로젝트 생성 → Stage 0~1)">
        <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          <b>레퍼런스</b>는 IG URL 또는 로컬 파일, <b>소스</b>는 로컬 파일을 업로드합니다.<br />
          레퍼런스가 IG URL 일 때만 ig-fetch 서버(<code>{`http://localhost:8000`}</code>)가 필요합니다.<br />
          <b>다운로드/저장 → Stage 0 (분석) → Stage 1 (컷편집)</b> 까지 자동 진행하며,
          이후 Stage 2~4 는 아래 "단계 실행" 에서 수동으로 트리거하세요.
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: '#444', marginBottom: 4 }}>레퍼런스 (1개)</div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 13 }}>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name="autoRefMode"
                checked={autoRefMode === 'url'}
                onChange={() => setAutoRefMode('url')}
                disabled={autoRunning || !!busy}
              />{' '}
              IG URL
            </label>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name="autoRefMode"
                checked={autoRefMode === 'file'}
                onChange={() => setAutoRefMode('file')}
                disabled={autoRunning || !!busy}
              />{' '}
              로컬 파일
            </label>
          </div>
          {autoRefMode === 'url' ? (
            <input
              type="text"
              value={autoRefUrl}
              onChange={e => setAutoRefUrl(e.target.value)}
              disabled={autoRunning || !!busy}
              placeholder="https://www.instagram.com/reel/XXXXX/"
              style={inputStyle}
            />
          ) : (
            <div>
              <input
                type="file"
                accept="video/*"
                onChange={e => setAutoRefFile(e.target.files?.[0] ?? null)}
                disabled={autoRunning || !!busy}
              />
              {autoRefFile && (
                <span style={{ fontSize: 12, color: '#555', marginLeft: 8 }}>
                  선택됨: {autoRefFile.name} ({(autoRefFile.size / 1024 / 1024).toFixed(1)} MB)
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: '#444', marginBottom: 4 }}>
            소스 파일 (여러 개 선택 가능 — 사용자가 직접 찍은 영상)
          </div>
          <input
            type="file"
            accept="video/*"
            multiple
            onChange={e => setAutoSourceFiles(Array.from(e.target.files ?? []))}
            disabled={autoRunning || !!busy}
          />
          {autoSourceFiles.length > 0 && (
            <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
              {autoSourceFiles.length}개 선택됨:{' '}
              {autoSourceFiles.map(f => f.name).join(', ')}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!autoRunning ? (
            <button
              onClick={runAutoPipeline}
              disabled={!!busy}
              style={{ background: '#e8f6ee', borderColor: '#2a8', fontWeight: 600 }}
            >
              🚀 자동 실행 (Stage 0~1 까지)
            </button>
          ) : (
            <button onClick={cancelAutoPipeline} style={{ background: '#fee', borderColor: '#e88' }}>
              중단
            </button>
          )}
          <span style={{ fontSize: 12, color: '#777' }}>
            예상 소요: IG 다운로드 + Stage 0 (~1-3분) + Stage 1 (소스 1개당 ~1-2분)
          </span>
        </div>

        {autoSteps.length > 0 && (
          <div style={{
            marginTop: 10, padding: 8, background: '#f7f7f9',
            border: '1px solid #ddd', borderRadius: 6, fontSize: 12,
            maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace',
          }}>
            {autoSteps.map((s, i) => (
              <div key={i}>
                <span style={{ color: '#888' }}>[{new Date(s.t).toLocaleTimeString()}]</span>{' '}
                <span style={{ color: '#a86b00' }}>{s.step}</span>{' '}
                {s.msg}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 업로드 */}
      <Section title="업로드 (수동)">
        <UploadRow
          label="레퍼런스 (1개, 필수)"
          accept="video/*"
          multiple={false}
          files={state?.uploads.reference || []}
          disabled={!projectId || !!busy}
          onPick={f => upload('reference', f)}
        />
        <UploadRow
          label="소스 영상/이미지 (여러 개, 필수 — 이미지는 정지 cut 으로 사용)"
          accept="video/*,image/*"
          multiple={true}
          files={state?.uploads.sources || []}
          disabled={!projectId || !!busy}
          onPick={f => upload('source', f)}
        />
        <UploadRow
          label="BGM (선택 — 업로드 없으면 Stage 4 가 Internet Archive 에서 자동으로 가져옴)"
          accept="audio/*"
          multiple={false}
          files={state?.uploads.bgm || []}
          disabled={!projectId || !!busy}
          onPick={f => upload('bgm', f)}
        />
      </Section>

      {/* 영상 스타일 브리프 */}
      <Section title="영상 스타일 브리프 (자막 톤·내용 결정용 — 빈 칸은 무시됨)">
        <div style={{ fontSize: 13, color: '#666', marginBottom: 10 }}>
          체크/선택과 자유 입력으로 원하는 영상의 느낌을 답하세요. <b>Stage 1 의 자막 플래닝과 재생성에 강하게 반영</b>됩니다.
        </div>
        <BriefForm brief={brief} disabled={!projectId || !!busy} onChange={updateBrief} />
        <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
          {briefSaving ? '저장 중…' : '입력 즉시 자동 저장. Stage 다시 실행할 때 반영됨.'}
        </div>
      </Section>

      {/* 단계 */}
      <Section title="단계 실행">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: 10, background: '#eef4ff', border: '1px solid #cdd9f3', borderRadius: 8, marginBottom: 12,
        }}>
          <button
            onClick={runAll}
            disabled={!projectId || !!busy || !refOk || !srcOk}
            style={{ background: '#4a7ad6', color: '#fff', borderColor: '#4a7ad6', fontWeight: 600, padding: '8px 16px' }}
          >
            ⚡ 한 번에 실행 (Stage 0 → 4)
          </button>
          <span style={{ fontSize: 12, color: '#555' }}>
            업로드 끝났으면 이 버튼 하나로 모든 단계 자동 실행.
            <b> 이미 완료된 단계도 무조건 처음부터 다시 실행</b>합니다.
            <b>TTS 활성</b> 시 나레이션 개요는 자동 생성·자동 확정 — 결과 마음에 안 들면 개요 편집 후 Stage 4 만 재실행하세요.
          </span>
        </div>
        {STAGE_INFO.map(s => {
          const { ok, reason } = canRun(s.id);
          const done = stageDone(s.id);
          const previewSrc = previewSrcForStage(s.id);
          const running = busyStage === s.id;
          return (
            <div key={s.id} style={{
              border: `1px solid ${running ? '#f0d27a' : '#ddd'}`, borderRadius: 8, padding: 12, marginBottom: 12,
              background: running ? '#fffbe6' : done ? '#f3fbf3' : '#fff',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <b>{s.title}</b>
                {done && <span style={{ color: 'green' }}>✓ 완료</span>}
                {running && <span style={{ color: '#a86b00' }}>⏳ 실행 중 {fmtElapsed(elapsedSec)}</span>}
                <span style={{ color: '#888', fontSize: 12 }}>({s.eta})</span>
                {!running && (
                  <button onClick={() => runStage(s.id)} disabled={!ok || !!busy}>
                    {done ? '다시 실행' : '실행'}
                  </button>
                )}
                {running && (
                  <button onClick={cancel} style={{ background: '#fee', borderColor: '#e88' }}>
                    중단
                  </button>
                )}
                {!ok && !running && <span style={{ color: '#a00' }}>{reason}</span>}
              </div>
              <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>{s.desc}</div>

              {s.id === 0 && done && state?.artifacts.editSpec && (
                <SpecPreview spec={state.artifacts.editSpec} />
              )}
              {s.id === 1 && done && state?.artifacts.editPlan && (
                <PlanPreview plan={state.artifacts.editPlan} />
              )}
              {s.id === 2 && done && state?.artifacts.colorStats && (
                <pre style={preStyle}>{JSON.stringify(state.artifacts.colorStats, null, 2)}</pre>
              )}
              {s.id >= 1 && previewSrc && (
                <div style={{ marginTop: 10 }}>
                  <video src={previewSrc} controls style={{ width: 320, maxWidth: '100%' }} />
                </div>
              )}

              {/* Stage 3 카드 안 — 자막 재생성 박스. Stage 1 결과(plan)가 있으면 항상 보임 */}
              {s.id === 3 && state?.stages.s1_cut && (
                <div style={{
                  marginTop: 12, padding: 10, background: '#fff8ee',
                  border: '1px solid #f0d27a', borderRadius: 6,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>
                    자막만 다시 생성 (검증 / 재생성)
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                    자막이 마음에 안 들면 피하고 싶은 표현을 추가하거나 피드백을 적고 버튼을 누르세요.
                    Stage 1 매칭/렌더는 그대로 두고 자막 plan + Stage 3 만 다시 돌립니다.
                  </div>

                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>
                      피하고 싶은 표현 (콤마 구분) — 이 단어/문구는 절대 자막에 안 나옴
                    </div>
                    <input
                      type="text"
                      value={brief.avoid_phrases.join(', ')}
                      onChange={e => {
                        const arr = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
                        updateBrief({ avoid_phrases: arr });
                      }}
                      disabled={!!busy}
                      placeholder="예: ㄹㅇ, 미쳤다, 행복한 시간, 즐거운 순간"
                      style={inputStyle}
                    />
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                      입력 즉시 스타일 브리프에 자동 저장됨 ({briefSaving ? '저장 중…' : '동기화됨'}).
                    </div>
                  </div>

                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>
                      이번 재생성에만 적용할 피드백 (선택)
                    </div>
                    <textarea
                      value={replanFeedback}
                      onChange={e => setReplanFeedback(e.target.value)}
                      disabled={!!busy}
                      placeholder='예: "더 짧게", "위 글씨를 더 크게", "hook 컷에는 노란색"'
                      maxLength={2000}
                      style={{ ...inputStyle, minHeight: 60, fontFamily: 'inherit' }}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      onClick={replanCaptions}
                      disabled={!!busy || replanning}
                      style={{ background: '#fff', borderColor: '#d0a040' }}
                    >
                      {replanning ? '재생성 중…' : '자막만 다시 생성 + Stage 3 재실행'}
                    </button>
                    <span style={{ fontSize: 12, color: '#777' }}>
                      비용: Gemini Flash 1회 + FFmpeg burn-in (대략 $0.01).
                    </span>
                  </div>
                </div>
              )}

              {/* Stage 3 카드 안 — TTS 나레이션. Stage 1 결과(plan)가 있으면 항상 보임.
                  Stage 4 가 TTS approve 없이는 실행 안 되므로 같은 카드 안에 둔다. */}
              {s.id === 3 && state?.stages.s1_cut && (
                <div style={{
                  marginTop: 12, padding: 10, background: '#f5f8ff',
                  border: '1px solid #b0c4de', borderRadius: 6,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>
                    음성 나레이션 (TTS) — Stage 4 에서 BGM 과 함께 mix
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
                    Gemini 2.5 Flash TTS Preview 로 한국어 나레이션을 합성. <b>합성 전에 개요(segments)를 먼저 생성해 검토·확정한 뒤 Stage 4 가 실행</b>됩니다.
                    활성화 시 원본 음성은 mute, TTS 가 메인 음성이 되고 BGM 은 자동 ducking 됩니다.
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <input type="checkbox" checked={tts.enabled}
                      onChange={e => updateTts({ enabled: e.target.checked })}
                      disabled={!projectId || !!busy}
                    />
                    <span style={{ fontWeight: 600 }}>TTS 활성</span>
                    <span style={{ fontSize: 12, color: '#888' }}>
                      {ttsSaving ? '저장 중…' : '입력 즉시 자동 저장'}
                    </span>
                  </label>

                  {tts.enabled && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <BriefRow label="보이스">
                        <select
                          value={tts.voice}
                          onChange={e => updateTts({ voice: e.target.value })}
                          disabled={!projectId || !!busy}
                          style={inputStyle}
                        >
                          {TTS_VOICE_OPTS.map(o => (
                            <option key={o.v} value={o.v}>{o.label}</option>
                          ))}
                        </select>
                      </BriefRow>

                      <div style={{
                        border: '1px solid #d0a040', borderRadius: 6,
                        padding: 12, background: '#fff8ee',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                          <b style={{ fontSize: 13 }}>나레이션 개요 (segments)</b>
                          <span style={{ fontSize: 12, color: '#666' }}>
                            {outline.segments.length > 0
                              ? `${outline.segments.length}개 · 모델: ${outline.generated_model || '-'} · ${outline.approved ? '확정됨' : '미확정'}`
                              : '아직 생성 안 됨'}
                          </span>
                          <button
                            onClick={generateOutline}
                            disabled={!state?.stages.s1_cut || !!busy || outlineBusy === 'generating'}
                            style={{ marginLeft: 'auto' }}
                          >
                            {outlineBusy === 'generating' ? '생성 중…' : (outline.segments.length > 0 ? '개요 재생성' : '개요 생성')}
                          </button>
                        </div>

                        {outlineIssues.length > 0 && (
                          <div style={{
                            fontSize: 12, color: '#a00', background: '#fdecec',
                            padding: 8, borderRadius: 4, marginBottom: 8,
                          }}>
                            {outlineIssues.map((m, i) => <div key={i}>⚠ {m}</div>)}
                          </div>
                        )}

                        {outline.segments.length > 0 && (
                          <>
                            <div style={{ maxHeight: 320, overflowY: 'auto', marginBottom: 8 }}>
                              {outline.segments.map((seg, i) => (
                                <div key={i} style={{
                                  padding: 6, marginBottom: 4, border: '1px solid #eee',
                                  borderRadius: 4, background: '#fff', fontSize: 12,
                                }}>
                                  <div style={{ color: '#888', display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <span>cut {seg.cut_index}</span>
                                    <span>{seg.output_start.toFixed(2)}~{seg.output_end.toFixed(2)}s ({(seg.output_end - seg.output_start).toFixed(2)}s)</span>
                                    <button
                                      onClick={() => removeSegment(i)}
                                      disabled={!!busy || !!outlineBusy}
                                      style={{ marginLeft: 'auto', background: '#fee', borderColor: '#e88', fontSize: 11, padding: '1px 6px' }}
                                    >
                                      삭제
                                    </button>
                                  </div>
                                  <textarea
                                    value={seg.text}
                                    onChange={e => updateSegmentText(i, e.target.value)}
                                    onBlur={() => commitOutlineEdits()}
                                    disabled={!!busy || !!outlineBusy}
                                    rows={2}
                                    style={{
                                      width: '100%', marginTop: 4, padding: 4, fontSize: 12,
                                      border: '1px solid #ccc', borderRadius: 3, boxSizing: 'border-box',
                                      fontFamily: 'inherit',
                                    }}
                                  />
                                </div>
                              ))}
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button
                                onClick={() => patchOutline({ approved: !outline.approved })}
                                disabled={!!busy || !!outlineBusy}
                                style={{
                                  background: outline.approved ? '#e8f6ee' : '#fff',
                                  borderColor: outline.approved ? '#2a8' : '#d0a040',
                                  fontWeight: 600,
                                }}
                              >
                                {outlineBusy === 'confirming'
                                  ? '저장 중…'
                                  : outline.approved
                                    ? '✓ 확정됨 (해제하기)'
                                    : '확인하고 진행 (approved=true)'}
                              </button>
                              <span style={{ fontSize: 12, color: '#666' }}>
                                {outline.approved
                                  ? 'Stage 4 실행 가능.'
                                  : 'Stage 4 진행 차단됨. 편집 후 확정 버튼을 누르세요.'}
                              </span>
                            </div>

                            {outline.last_synthesis && outline.last_synthesis.notes.length > 0 && (
                              <div style={{
                                marginTop: 8, padding: 6, fontSize: 11, color: '#555',
                                background: '#f4f4f4', borderRadius: 4,
                              }}>
                                <div style={{ fontWeight: 600, marginBottom: 2 }}>최근 합성 시 자동 보정:</div>
                                {outline.last_synthesis.notes.map((n, i) => <div key={i}>· {n}</div>)}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {err && <div style={statusStyle('#fff0f0')}>⚠ {err}</div>}

      <Section title="로그">
        <pre style={preStyle}>{log.join('\n') || '(없음)'}</pre>
      </Section>
    </div>
  );
}

// ============================================================
// 보조 함수
// ============================================================

function parseSseBlock(block: string): { event: string; data: any } | null {
  // "event: progress\ndata: {...}" 형태의 SSE 블록을 파싱.
  // event 가 없으면 'message' 가 기본. data 가 여러 줄이면 \n 으로 합침.
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: { msg: raw } };
  }
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${String(s).padStart(2, '0')}초` : `${s}초`;
}

function summarizeResult(j: any): string {
  // 결과를 한 줄로
  const bits: string[] = [];

  // 레퍼런스 BGM 지문인식 결과는 사람이 읽기 좋게 별도 표기
  const rb = j.reference_bgm;
  if (rb && typeof rb === 'object') {
    if (rb.status === 'matched') {
      const name = [rb.title, rb.artist].filter(Boolean).join(' - ') || '(제목 미상)';
      const g = Array.isArray(rb.genres) && rb.genres.length ? ` [${rb.genres.join('/')}]` : '';
      const link = rb.song_link || rb.spotify_url || rb.apple_url;
      bits.push(`🎵 레퍼런스 원곡: "${name}"${g}${link ? ` → ${link}` : ''}`);
    } else if (rb.status === 'no_match') {
      bits.push('🎵 레퍼런스 원곡 식별 실패 (매칭 없음 — 무료트랙 자동매칭으로 진행)');
    } else if (rb.status === 'error') {
      bits.push('🎵 레퍼런스 원곡 식별 오류 (무료트랙 자동매칭으로 진행)');
    }
  }

  const keys = Object.keys(j).filter(k => !['ok', 'stage', 'reference_bgm'].includes(k));
  for (const k of keys.slice(0, 6)) {
    const v = j[k];
    if (typeof v === 'object' && v !== null) bits.push(`${k}=${JSON.stringify(v).slice(0, 60)}`);
    else bits.push(`${k}=${v}`);
  }
  return bits.join(' / ');
}

function notifyComplete(title: string, body: string) {
  // 1) 데스크탑 알림
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {}
  // 2) 페이지 타이틀 점멸
  try {
    const orig = document.title;
    document.title = `✓ ${title}`;
    setTimeout(() => { document.title = orig; }, 5000);
  } catch {}
  // 3) 짧은 비프 사운드
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; // A5
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => ctx.close();
  } catch {}
}

// ============================================================
// 작은 컴포넌트
// ============================================================
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function UploadRow({
  label, accept, multiple, files, disabled, onPick,
}: {
  label: string; accept: string; multiple: boolean;
  files: string[]; disabled: boolean;
  onPick: (f: FileList | null) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 13, color: '#444' }}>{label}</div>
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={e => onPick(e.target.files)}
      />
      {files.length > 0 && (
        <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
          업로드됨: {files.join(', ')}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 영상 스타일 브리프 폼
// ============================================================
const CATEGORY_OPTS = [
  { v: 'food', label: '음식' }, { v: 'travel', label: '여행' }, { v: 'fashion', label: '패션' },
  { v: 'fitness', label: '운동' }, { v: 'study', label: '공부' }, { v: 'product', label: '제품/홍보' },
  { v: 'daily', label: '일상' }, { v: 'other', label: '기타' },
];
const PURPOSE_OPTS = [
  { v: 'info', label: '정보 전달' }, { v: 'review', label: '후기/리뷰' },
  { v: 'daily', label: '일상 기록' }, { v: 'promo', label: '홍보/CTA' },
  { v: 'emotional', label: '감성' }, { v: 'other', label: '기타' },
];
const TONE_OPTS = [
  { v: 'calm', label: '차분/잔잔' }, { v: 'energetic', label: '활발/에너지' },
  { v: 'serious', label: '진지/정보' }, { v: 'humorous', label: '유머/위트' },
  { v: 'poetic', label: '감성/시적' }, { v: 'formal', label: '정중/격식' },
];
const FORMALITY_OPTS = [
  { v: 'casual', label: '반말' }, { v: 'formal', label: '존댓말' }, { v: 'mixed', label: '혼합' },
];
const DENSITY_OPTS = [
  { v: 'every_cut', label: '거의 모든 컷' }, { v: 'most_cuts', label: '절반 이상' },
  { v: 'occasional', label: '가끔' }, { v: 'minimal', label: '강조 컷만' }, { v: 'none', label: '자막 없이' },
];
const CAPTION_MODE_OPTS = [
  { v: 'none', label: '없음' },
  { v: 'per_scene', label: '장면마다 바뀜' },
  { v: 'continuous', label: '하나가 끝까지' },
];
const LANGUAGE_OPTS = [
  { v: 'ko', label: '한국어' },
  { v: 'en', label: '영어' },
  { v: 'mixed', label: '한국어+영어' },
];

function BriefForm({
  brief, disabled, onChange,
}: {
  brief: StyleBrief;
  disabled: boolean;
  onChange: (patch: Partial<StyleBrief>) => void;
}) {
  const setArray = (key: 'topic_keywords' | 'avoid_phrases' | 'must_include_phrases') => (raw: string) => {
    const arr = raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    onChange({ [key]: arr } as any);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <BriefRow label="영상 카테고리">
        <PillGroup
          value={brief.category} options={CATEGORY_OPTS} disabled={disabled}
          onChange={v => onChange({ category: v })}
        />
        {brief.category === 'other' && (
          <input
            type="text" placeholder="기타 카테고리 직접 입력"
            value={brief.category_other} disabled={disabled}
            onChange={e => onChange({ category_other: e.target.value })}
            style={inputStyle}
          />
        )}
      </BriefRow>

      <BriefRow label="영상 목적">
        <PillGroup value={brief.purpose} options={PURPOSE_OPTS} disabled={disabled}
          onChange={v => onChange({ purpose: v })} />
      </BriefRow>

      <BriefRow label="원하는 톤">
        <PillGroup value={brief.tone} options={TONE_OPTS} disabled={disabled}
          onChange={v => onChange({ tone: v })} />
      </BriefRow>

      <BriefRow label="친밀도/격식">
        <PillGroup value={brief.formality} options={FORMALITY_OPTS} disabled={disabled}
          onChange={v => onChange({ formality: v })} />
      </BriefRow>

      <BriefRow label="자막 모드">
        <PillGroup value={brief.caption_mode} options={CAPTION_MODE_OPTS} disabled={disabled}
          onChange={v => onChange({ caption_mode: v, caption_density: v === 'none' ? 'none' : '' })} />
      </BriefRow>

      <BriefRow label="자막 언어">
        <PillGroup value={brief.caption_language} options={LANGUAGE_OPTS} disabled={disabled}
          onChange={v => onChange({ caption_language: v })} />
      </BriefRow>

      <BriefRow label="다루는 주제 키워드 (콤마로 구분)">
        <input type="text" disabled={disabled} style={inputStyle}
          placeholder="예: 라면, 칼칼한, 면치기, 1인분"
          value={brief.topic_keywords.join(', ')}
          onChange={e => setArray('topic_keywords')(e.target.value)} />
      </BriefRow>

      <BriefRow label="피하고 싶은 표현 (콤마로 구분) — 절대 사용 금지">
        <input type="text" disabled={disabled} style={inputStyle}
          placeholder="예: ㄹㅇ, 미쳤다, 행복한 시간"
          value={brief.avoid_phrases.join(', ')}
          onChange={e => setArray('avoid_phrases')(e.target.value)} />
      </BriefRow>

      <BriefRow label="꼭 들어갔으면 하는 문구 (콤마로 구분)">
        <input type="text" disabled={disabled} style={inputStyle}
          placeholder="예: 면치기 한 입, 한 번 더 갈게요"
          value={brief.must_include_phrases.join(', ')}
          onChange={e => setArray('must_include_phrases')(e.target.value)} />
      </BriefRow>

      <BriefRow label="추가 메모 (자유 입력, 선택)">
        <textarea disabled={disabled}
          value={brief.extra_notes}
          onChange={e => onChange({ extra_notes: e.target.value })}
          placeholder="위 항목으로 표현 안 되는 추가 요청. 비워둬도 됨."
          maxLength={2000}
          style={{ ...inputStyle, minHeight: 60, fontFamily: 'inherit' }}
        />
      </BriefRow>
    </div>
  );
}

function BriefRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function PillGroup({
  value, options, disabled, onChange,
}: {
  value: string;
  options: { v: string; label: string }[];
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {options.map(o => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(active ? '' : o.v)}
            style={{
              padding: '4px 10px',
              borderRadius: 16,
              border: active ? '2px solid #2a8' : '1px solid #ccc',
              background: active ? '#e8f6ee' : '#fff',
              color: active ? '#185' : '#444',
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: 6, fontSize: 13,
  borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box',
};

function SpecPreview({ spec }: { spec: any }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13 }}>
        길이 <b>{Number(spec.duration || 0).toFixed(2)}s</b> / 컷 <b>{spec.shots_count}</b>개 / 페이싱 {spec.pacing} / 색감 {JSON.stringify(spec.color_style)}
      </div>
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>shots 펼치기</summary>
        <pre style={preStyle}>{JSON.stringify(spec.shots, null, 2)}</pre>
      </details>
    </div>
  );
}
function PlanPreview({ plan }: { plan: any }) {
  const items: any[] = Array.isArray(plan.items) ? plan.items : [];
  const totalLayers = items.reduce((s, it) => s + ((it.planned_caption_layers || []).length), 0);
  const cutsWithCap = items.filter(it => (it.planned_caption_layers || []).length > 0).length;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13 }}>
        총 {plan.items_count}컷, 출력길이 {plan.output_duration}s, 자막 있는 컷 {cutsWithCap}, 총 layer {totalLayers}
      </div>

      <details style={{ marginTop: 6 }} open>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>미리 작성된 자막 보기</summary>
        <div style={{ marginTop: 6 }}>
          {items.map((it: any, i: number) => {
            const layers: any[] = it.planned_caption_layers || [];
            return (
              <div key={i} style={{
                padding: 6, marginBottom: 4, border: '1px solid #eee', borderRadius: 4,
                fontSize: 12, background: layers.length === 0 ? '#fafafa' : '#fff',
              }}>
                <div style={{ color: '#888' }}>
                  cut {i} ({Number(it.output_start).toFixed(2)}~{Number(it.output_end).toFixed(2)}s) ← {it.source_filename}
                </div>
                {layers.length === 0 ? (
                  <div style={{ color: '#aaa' }}>(자막 없음)</div>
                ) : (
                  layers.map((l: any, li: number) => (
                    <div key={li} style={{ marginLeft: 12, marginTop: 2 }}>
                      <span style={{
                        display: 'inline-block', padding: '1px 6px', marginRight: 6,
                        background: '#eef', borderRadius: 3, fontSize: 11,
                      }}>
                        {l.position}/{l.horizontal_align} · {l.size_level} · {l.font_category}
                        {l.font_personality ? `/${l.font_personality}` : ''} · {l.emphasis}{l.italic ? '+italic' : ''}
                        {l.color_hex ? ` · ${l.color_hex}` : ''} · [{l.role}]
                      </span>
                      <b style={{ fontStyle: l.italic ? 'italic' : 'normal' }}>{l.text}</b>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </details>

      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>매칭 상세 JSON</summary>
        <pre style={preStyle}>{JSON.stringify(items, null, 2)}</pre>
      </details>
    </div>
  );
}

const preStyle: React.CSSProperties = {
  background: '#f7f7f7', padding: 10, borderRadius: 6,
  fontSize: 12, maxHeight: 300, overflow: 'auto',
};

const statusStyle = (bg: string): React.CSSProperties => ({
  background: bg, padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13,
});
