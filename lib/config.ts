// ============================================================
// 모든 API 키 / 모델 / 경로 설정을 한 파일에서 관리.
// .env.local 에 동일 이름으로 넣어도 되고, 여기 기본값을 바꿔도 된다.
// ============================================================

export const config = {
  // -------- Gemini (Stage 0 분석, Stage 1 segment 묘사) --------
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  // 레퍼런스 분석에 사용 (정확도 우선). 무료 티어에는 포함되지 않으니 billing 활성화 필요.
  GEMINI_PRO_MODEL: process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro',
  // 소스 영상 segment 묘사 + caption planning 에 사용 (비용 우선).
  // 2026-05-19 GA. 이전 기본값: gemini-2.5-flash.
  GEMINI_FLASH_MODEL: process.env.GEMINI_FLASH_MODEL ?? 'gemini-3.5-flash',
  // Nano Banana — 자막 PNG 생성 (Stage 3 AI 모드)
  // 'gemini-2.5-flash-image' (Nano Banana, 싼 옵션) / 'gemini-3-pro-image' (Nano Banana Pro, 정확도↑)
  NANO_BANANA_MODEL: process.env.NANO_BANANA_MODEL ?? 'gemini-2.5-flash-image',
  // TTS (Stage 4 narration). 가격: 입력 $0.50, 출력 $10.00/M 토큰 (오디오).
  // 한국어 voice 지원. responseModalities=['AUDIO'] + speechConfig.voiceConfig 로 호출.
  GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts',
  GEMINI_API_BASE: process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com',

  // -------- OpenAI (Stage 1 매칭용 embedding) --------
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
  OPENAI_API_BASE: process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',

  // -------- FFmpeg (모든 단계의 실제 영상 처리) --------
  FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',

  // -------- ig-fetch (Instagram 다운로드 헬퍼 서비스) --------
  // 사용자가 별도로 띄움: cd ig-fetch && uvicorn app.main:app --port 8000
  IG_FETCH_BASE: process.env.IG_FETCH_BASE ?? 'http://localhost:8000',
  // pending 폴링 한계 (각 URL 당)
  IG_FETCH_POLL_TIMEOUT_MS: Number(process.env.IG_FETCH_POLL_TIMEOUT_MS ?? 180_000),
  IG_FETCH_POLL_INTERVAL_MS: Number(process.env.IG_FETCH_POLL_INTERVAL_MS ?? 2000),
};

export type StageId = 0 | 1 | 2 | 3 | 4;

// 각 단계에서 어떤 외부 API 가 필요한지 정의
// Stage 3 는 styleNote 가 있으면 Gemini 호출하지만, 없으면 FFmpeg 만으로 충분 → required 로는 두지 않음 (있으면 더 좋음).
export const STAGE_REQUIREMENTS: Record<StageId, { keys: (keyof typeof config)[]; label: string }> = {
  0: { keys: ['GEMINI_API_KEY'], label: '레퍼런스 영상 분석 (Gemini Pro)' },
  1: { keys: ['GEMINI_API_KEY', 'OPENAI_API_KEY'], label: '컷편집 (Gemini Flash + OpenAI embedding + FFmpeg)' },
  2: { keys: [], label: '영상 보정 (FFmpeg only)' },
  3: { keys: [], label: '자막 (FFmpeg; styleNote 있으면 Gemini Flash 자동 호출)' },
  4: { keys: [], label: '음성/BGM (FFmpeg + Internet Archive 자동 검색)' },
};

export function checkStageConfig(stage: StageId): string | null {
  const req = STAGE_REQUIREMENTS[stage];
  for (const k of req.keys) {
    if (!config[k]) return `Stage ${stage} (${req.label}) 에 ${k} 가 필요합니다`;
  }
  return null;
}
