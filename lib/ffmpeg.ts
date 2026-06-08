// ============================================================
// FFmpeg / FFprobe 래퍼 + 영상 측정 유틸리티
// - runFfmpeg / runFfprobe : 임의 명령 실행
// - probeDuration / probeMetadata : 길이/메타데이터
// - detectShots : 컷 경계 검출 (scene detection)
// - measureSignalStats : 색 통계 (밝기/채도/색온도 등)
// ============================================================

import { spawn } from 'child_process';
import { config } from './config';

export async function runFfmpeg(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return runBinary(config.FFMPEG_PATH, args, cwd);
}

export async function runFfprobe(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runBinary(config.FFPROBE_PATH, args);
}

// 디버깅용 — env FFMPEG_VERBOSE=1 이면 명령/진행률을 backend stdout 에 실시간 흘림.
// ffmpeg 의 stderr 에는 `frame=NN fps=NN time=00:00:04.0 ...` 진행률이 1초마다
// 갱신되므로, 켜두면 어디서 hang 인지 / 어느 segment 에서 느린지 즉시 보인다.
function ffmpegVerbose(): boolean {
  return process.env.FFMPEG_VERBOSE === '1' || process.env.FFMPEG_VERBOSE === 'true';
}

function runBinary(bin: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const verbose = ffmpegVerbose();
    const t0 = Date.now();
    if (verbose) {
      const shortBin = bin.split(/[\\/]/).pop() || bin;
      console.log(`\n[ffmpeg] $ ${shortBin} ${args.join(' ')}${cwd ? `   (cwd=${cwd})` : ''}`);
    }

    let proc;
    try {
      proc = spawn(bin, args, { cwd });
    } catch (e: any) {
      return reject(new Error(`${bin} 실행 실패: ${e.message}`));
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      stdout += d.toString();
      if (verbose) process.stdout.write(d);
    });
    proc.stderr.on('data', d => {
      stderr += d.toString();
      // ffmpeg 진행 보고가 여기로 옴 → verbose 모드에서 실시간 흘리기
      if (verbose) process.stderr.write(d);
    });
    proc.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`${bin} 을(를) 찾을 수 없습니다. FFmpeg/ffprobe 가 PATH 에 있는지 확인하세요.`));
      } else {
        reject(err);
      }
    });
    proc.on('close', code => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (verbose) console.log(`[ffmpeg] exit ${code}  (${elapsed}s)`);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

// ---------- 메타데이터 ----------

export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const d = parseFloat(stdout.trim());
  return isFinite(d) ? d : 0;
}

export async function probeMetadata(filePath: string): Promise<any> {
  const { stdout } = await runFfprobe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  return JSON.parse(stdout);
}

// ---------- shot 프레임 / 오디오 추출 ----------
// 풀 영상을 Gemini 에 업로드하지 않고, shot 별 키프레임 + 오디오만 보내는
// fast path (Stage 1 source 분석) 를 위해 분리.

// 영상에 오디오 트랙이 존재하는지 확인.
export async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const meta = await probeMetadata(filePath);
    return Array.isArray(meta?.streams) && meta.streams.some((s: any) => s?.codec_type === 'audio');
  } catch {
    return false;
  }
}

// 단일 프레임 캡쳐. 토큰 절약을 위해 가로 720 으로 다운스케일.
export async function extractFrame(
  filePath: string,
  timestamp: number,
  outPath: string,
  width = 720,
): Promise<void> {
  await runFfmpeg([
    '-y',
    '-ss', Math.max(0, timestamp).toFixed(3),
    '-i', filePath,
    '-an',                 // 오디오 디코드 생략 (프레임 1장만 필요)
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    outPath,
  ]);
}

// 추출된 프레임 이미지에서 '가로 전체 × 세로 밴드' 를 크롭 + 업스케일한다.
// 자막은 가로로 길어, 자막의 세로 중심(verticalRatio) 기준 밴드를 잘라 업스케일하면
// 자막이 이미지를 꽉 채워 VLM 이 색/박스/그림자/굵기를 풀프레임보다 정확히 읽는다.
// iw/ih 식으로 처리해 원본 프레임 해상도를 몰라도 동작한다. (필터식 내부 콤마는 \, 로 이스케이프)
export async function cropBand(
  srcImage: string,
  outPath: string,
  verticalRatio: number,
  bandFrac: number,
  outWidth = 1280,
): Promise<void> {
  const vr = Math.max(0, Math.min(1, Number(verticalRatio) || 0.5));
  const F = Math.max(0.05, Math.min(0.9, Number(bandFrac) || 0.24));
  const f = F.toFixed(4);
  // 밴드 상단 y = 중심 - F/2, [0, ih*(1-F)] 로 클램프.
  const y = `max(0\\,min(ih*(1-${f})\\,ih*${vr.toFixed(4)}-ih*${(F / 2).toFixed(4)}))`;
  const vf = `crop=iw:ih*${f}:0:${y},scale=${outWidth}:-2:flags=lanczos`;
  await runFfmpeg(['-y', '-i', srcImage, '-vf', vf, '-frames:v', '1', '-q:v', '3', outPath]);
}

// 정규화 bbox(0~1) 영역을 패딩 포함 크롭 + 업스케일. (로컬라이제이션으로 찾은 자막 위치를 타이트하게 자를 때)
export async function cropRegion(
  srcImage: string,
  outPath: string,
  x: number, y: number, w: number, h: number,   // 정규화 0~1 (좌상단 x,y + 폭/높이)
  pad = 0.04,
  outWidth = 1280,
): Promise<void> {
  const c01 = (v: number) => Math.max(0, Math.min(1, Number(v)));
  const x0 = c01(x - pad), y0 = c01(y - pad);
  const x1 = c01(x + w + pad), y1 = c01(y + h + pad);
  const cw = Math.max(0.02, x1 - x0), ch = Math.max(0.02, y1 - y0);
  const vf = `crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${x0.toFixed(4)}:ih*${y0.toFixed(4)},scale=${outWidth}:-2:flags=lanczos`;
  await runFfmpeg(['-y', '-i', srcImage, '-vf', vf, '-frames:v', '1', '-q:v', '3', outPath]);
}

// 영상 → 단일 mp3 오디오. Gemini 가 안정적으로 받는 포맷.
// mono / 24kHz / 48kbps 로 충분 (발화 식별 목적).
export async function extractAudio(filePath: string, outPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i', filePath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '48k',
    '-ar', '24000',
    '-ac', '1',
    outPath,
  ]);
}

// 특정 시간 구간만 mp3 로 추출. 긴 소스를 batch 로 나눠 분석할 때 사용.
// (-ss 를 -i 앞에 둬서 빠른 seek, -t 로 구간 길이 지정)
export async function extractAudioRange(
  filePath: string,
  start: number,
  duration: number,
  outPath: string,
): Promise<void> {
  await runFfmpeg([
    '-y',
    '-ss', Math.max(0, start).toFixed(3),
    '-i', filePath,
    '-t', Math.max(0.1, duration).toFixed(3),
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '48k',
    '-ar', '24000',
    '-ac', '1',
    outPath,
  ]);
}

// ---------- 컷 경계 검출 (scene detection) ----------
// FFmpeg 의 select=gt(scene\,threshold) 로 큰 장면 변화 지점을 찾는다.
// threshold 0.2~0.4 권장 (0 = 모든 프레임, 1 = 변화 없음).

export type Shot = { start: number; end: number; duration: number };

// scene 점수는 작은 해상도에서 계산해도 컷 경계는 거의 동일하게 잡힌다.
// 풀 해상도(예 1080p, 2M px) 대신 높이 144 (~수만 px) 로 줄이면 scene 필터 비용이 픽셀 수만큼 급감.
const SCENE_DETECT_HEIGHT = 144;

export async function detectShots(filePath: string, threshold = 0.22): Promise<Shot[]> {
  const duration = await probeDuration(filePath);
  if (duration <= 0) return [];

  const hw = (config.FFMPEG_HWACCEL || '').trim();
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    // (선택) GPU decode 가속. 빈 값이면 생략(CPU).
    ...(hw ? ['-hwaccel', hw] : []),
    // (선택) 비참조 프레임 decode 생략으로 CPU 디코드량 감소. (token 은 'noref' 가 정답)
    ...(config.FFMPEG_SCENE_SKIP_NONREF ? ['-skip_frame', 'noref'] : []),
    '-i', filePath,
    '-an',                                    // 오디오 디코드 생략
    // scale 을 select 앞에 둬서 scene 점수/showinfo 계산을 작은 프레임에서 수행.
    // pts(타임스탬프) 는 scale 과 무관하게 원본 기준 그대로라 컷 경계 정확도 유지.
    '-filter_complex', `scale=-2:${SCENE_DETECT_HEIGHT}:flags=fast_bilinear,select='gt(scene,${threshold})',showinfo`,
    '-f', 'null',
    '-',
  ]).catch(e => ({ stderr: String(e?.message ?? e), stdout: '' } as any));

  // showinfo 출력 라인: "[Parsed_showinfo_1 @ ...] n: ... pts_time:1.234 ..."
  const cutTimes: number[] = [];
  const re = /pts_time:([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    if (isFinite(t) && t > 0) cutTimes.push(t);
  }
  cutTimes.sort((a, b) => a - b);

  // boundaries → shots
  // 검출된 컷 경계 그대로 사용. sub-shot 분할은 하지 않는다.
  // (인위적으로 쪼개면 같은 내용이 여러 컷에 반복되는 문제 발생)
  const boundaries = [0, ...cutTimes, duration].filter((v, i, arr) => i === 0 || v - arr[i - 1] > 0.1);
  const shots: Shot[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i];
    const e = boundaries[i + 1];
    if (e - s < 0.2) continue; // 너무 짧은 segment 는 무시
    shots.push({ start: round3(s), end: round3(e), duration: round3(e - s) });
  }
  // 컷이 하나도 안 잡힌 경우 영상 전체를 단일 shot 으로
  if (shots.length === 0) {
    shots.push({ start: 0, end: round3(duration), duration: round3(duration) });
  }
  return shots;
}

// ---------- 색 통계 (signalstats) ----------
// YAVG: 밝기 평균(0~255), YSTDDEV: 대비, USAT/VSAT: 채도, HUEAVG: 색조
export type SignalStats = {
  yavg: number;     // 0-255
  ystddev: number;  // 대비 근사
  usat: number;     // U(파랑-노랑) 채도
  vsat: number;     // V(빨강-청록) 채도
  hueavg: number;   // 평균 hue (deg)
  satavg: number;   // (usat+vsat)/2
};

export async function measureSignalStats(filePath: string): Promise<SignalStats> {
  // metadata=print:file=- 는 통계 라인을 stdout 으로, FFmpeg 로그를 stderr 로 내보낸다.
  // 둘 다 합쳐 파싱해야 실행 환경 차이에도 값이 0으로 떨어지지 않는다.
  const { stdout, stderr } = await runFfmpeg([
    '-hide_banner',
    '-i', filePath,
    '-an',
    '-vf', 'signalstats,metadata=print:file=-',
    '-f', 'null',
    '-',
  ]).catch(e => ({ stderr: String(e?.message ?? e), stdout: '' } as any));

  const output = `${stdout}\n${stderr}`;

  // metadata=print 라인들:
  // "frame:0    pts:..."
  // "lavfi.signalstats.YAVG=123.45"
  // ...
  const collect = (key: string): number[] => {
    const re = new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.\\-eE]+)`, 'g');
    const out: number[] = [];
    let m;
    while ((m = re.exec(output)) !== null) {
      const v = parseFloat(m[1]);
      if (isFinite(v)) out.push(v);
    }
    return out;
  };

  const yavg = avg(collect('YAVG'));
  const ylow = avg(collect('YLOW'));
  const yhigh = avg(collect('YHIGH'));
  const ymin = avg(collect('YMIN'));
  const ymax = avg(collect('YMAX'));
  const contrastSpread = yhigh > ylow ? yhigh - ylow : Math.max(0, ymax - ymin);
  const usat = avg(collect('UAVG'));
  const vsat = avg(collect('VAVG'));
  const hueavg = avg(collect('HUEAVG'));
  const satavg = avg(collect('SATAVG'));

  return {
    yavg,
    ystddev: contrastSpread,
    usat,
    vsat,
    hueavg,
    satavg,
  };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
