// ============================================================
// Stage 4: 음성/BGM 입히기
// 입력: 3_caption/captioned.mp4 + (선택) bgm/ + edit-spec.json + edit-plan.json
// 출력: 4_final/final.mp4
//
// 오디오 정책:
// 1. 원본 영상 소리(현장음)는 audio-config.json 의 originalVolume 으로 제어:
//      'mute'(기본) → 원본 빼고 음원(BGM)만   /  'low','full' → 원본 살리고 BGM 은 그 아래로 ducking.
//    원본을 살릴 때 source_has_speech==false 구간은 잡음으로 보고 추가로 mute.
// 2. BGM 볼륨은 모드별로 다름 (constants 참고): BGM only(원본 mute)=1.0, 원본 살림=0.55, TTS 메인=0.13.
//    발화/나레이션 구간에선 sidechain ducking 으로 자동 압축.
// 3. TTS(나레이션)가 켜지면 원본은 항상 mute 되고 TTS 가 메인 음성. (lib/narration.ts 가 segments 생성)
// 4. 최종 loudnorm 은 I=-14 LUFS (SNS/유튜브 표준에 가까움).
//
// BGM 결정 우선순위:
//   업로드된 BGM > Internet Archive 자동 다운로드 > 없음.
// 최종 mode: voice_only | bgm_mixed | bgm_only | tts_only | tts_bgm_mixed.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { ARTIFACTS, appendRawResponse, bgmDir, ensureDir, readJson, referenceDir, stageDir, writeJson } from '../paths';
import { probeDuration, runFfmpeg } from '../ffmpeg';
import { fetchBgmFromArchive } from '../archive';
import { archiveHintsFromIdentity, BgmIdentifyResult, identifyReferenceBgm } from '../bgm-identify';
import { readTtsConfig, TtsConfig } from '../tts-config';
import { NarrationSegment, writeTtsOutline } from '../tts-outline';
import { prepareNarrationOutline } from '../narration';
import { readAudioConfig, ORIGINAL_VOLUME_GAIN } from '../audio-config';
import { config } from '../config';
import { DEFAULT_VOICE, synthesizeTtsToWav } from '../tts';

// BGM 볼륨: TTS 가 있을 때는 BGM 을 매우 작게 깔아서 TTS 우선 보장.
// 추가로 sidechain ducking 이 발화 중에 더 줄여줌 (release 180ms 로 빠르게 복귀).
const BGM_VOLUME_NO_TTS = 0.55;           // 원본 voice 를 살리고 BGM 을 그 아래로 깔 때 (ducking 별도)
const BGM_VOLUME_SOLO = 1.0;              // BGM only (원본 mute) — BGM 이 유일 음원이라 크게. loudnorm 이 최종 평준화.
const BGM_VOLUME_WITH_TTS = 0.13;         // TTS 가 메인 음성일 때 BGM 깔개 (sidechain ducking 별도)
const TTS_VOLUME_BOOST = 1.30;            // TTS 자체 볼륨 부스트 (loudnorm 전, BGM 대비 명확히)
// 각 TTS segment 의 음량 일정화 — Gemini TTS preview 가 segment 마다 음량이 들쭉날쭉이라
// dynaudnorm 으로 frame 단위 평준화. p=0.9 / m=8 정도가 음성에 자연스러움.
const TTS_DYNAUDNORM = 'dynaudnorm=f=500:g=15:p=0.9:m=8';
const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11';

type AudioProfile = {
  has_bgm?: boolean;
  bgm_mood?: string;
  bgm_genre?: string;
  bgm_tempo?: string;
  bgm_energy?: string;
  bgm_instruments?: string[];
  extra_terms?: string[];
};

type TtsLayer = { start: number; path: string; duration: number; atempo: number; slotDuration: number };

export async function runStage4(projectId: string): Promise<{
  ok: true;
  mode: 'voice_only' | 'bgm_mixed' | 'bgm_only' | 'tts_only' | 'tts_bgm_mixed';
  bgm?: { source: 'uploaded' | 'archive'; title?: string; identifier?: string; query_used?: string };
  reference_bgm?: {
    status: 'no_token' | 'no_match' | 'matched' | 'error';
    title?: string; artist?: string; album?: string; release_date?: string;
    genres?: string[]; song_link?: string; spotify_url?: string; apple_url?: string;
  };
  tts?: { voice: string; layers: number; corrections: number };
  noise_muted_ranges: number;        // 노이즈로 판단되어 mute 한 컷 수
}> {
  const captioned = ARTIFACTS.captionedMp4(projectId);
  if (!(await fileOk(captioned))) throw new Error('Stage 3 (captioned.mp4) 결과가 없습니다');

  await ensureDir(stageDir(projectId, 4));
  const finalPath = ARTIFACTS.finalMp4(projectId);

  // ---- 발화 없는 시간대 (노이즈 mute 대상) 수집 ----
  const plan: any = await readJson(ARTIFACTS.editPlan(projectId));
  const noiseRanges: { start: number; end: number }[] = [];
  if (plan?.items) {
    for (const it of plan.items) {
      if (it.source_has_speech === false) {
        const s = Number(it.output_start);
        const e = Number(it.output_end);
        if (isFinite(s) && isFinite(e) && e > s) noiseRanges.push({ start: s, end: e });
      }
    }
  }
  const noiseEnableExpr = buildEnableExpr(noiseRanges);

  // ---- BGM 결정 ----
  const allBgms = await listBgmFiles(projectId);
  const uploaded = allBgms.filter(p => !path.basename(p).startsWith('archive_'));
  const oldArchive = allBgms.filter(p => path.basename(p).startsWith('archive_'));

  let bgms: string[] = [];
  let bgmSource: 'uploaded' | 'archive' = 'uploaded';
  let archiveMeta: { title?: string; identifier?: string; query_used?: string } | undefined;
  let refBgm: BgmIdentifyResult | undefined;
  const spec: any = await readJson(ARTIFACTS.editSpec(projectId));
  const audioProfile: AudioProfile = spec?.audio_profile || {};

  if (uploaded.length > 0) {
    bgms = uploaded;
    bgmSource = 'uploaded';
  } else {
    for (const p of oldArchive) await fs.rm(p, { force: true });
    if (audioProfile.has_bgm === false) {
      bgms = [];
    } else {
      // ---- (선택) 레퍼런스 실제 BGM 지문인식 → 무료트랙 매칭 가이드 ----
      // AUDD_API_TOKEN 이 있을 때만 동작. 식별돼도 상용곡은 임베드하지 않고,
      // 장르/시대 힌트만 Internet Archive 검색(extra_terms)에 흘린다.
      refBgm = await identifyReferenceBgmSafe(projectId);
      if (refBgm?.status === 'matched' && refBgm.identity) {
        const hints = archiveHintsFromIdentity(refBgm.identity);
        if (hints.extra_terms.length > 0) {
          audioProfile.extra_terms = hints.extra_terms;
          if (!audioProfile.bgm_genre && hints.genre) audioProfile.bgm_genre = hints.genre;
        }
        await writeJson(ARTIFACTS.bgmIdentity(projectId), refBgm.identity);
        await appendRawResponse(projectId, {
          stage: 4, kind: 'reference_bgm_identified',
          identity: refBgm.identity, archive_hints: hints,
        });
      } else if (refBgm && refBgm.status !== 'no_token') {
        await appendRawResponse(projectId, {
          stage: 4, kind: 'reference_bgm_identify_skipped',
          status: refBgm.status, error: refBgm.error,
        });
      }

      try {
        const fetched = await fetchBgmFromArchive(audioProfile, bgmDir(projectId));
        await appendRawResponse(projectId, {
          stage: 4, kind: 'internet_archive_bgm',
          profile: audioProfile, query_used: fetched.query_used,
          identifier: fetched.identifier, title: fetched.title,
          candidate_pool_size: fetched.candidate_pool_size, source_url: fetched.source_url,
        });
        bgms = [fetched.path];
        bgmSource = 'archive';
        archiveMeta = { title: fetched.title, identifier: fetched.identifier, query_used: fetched.query_used };
      } catch (e: any) {
        await appendRawResponse(projectId, {
          stage: 4, kind: 'internet_archive_bgm_failed',
          profile: audioProfile, error: e.message || String(e),
        });
      }
    }
  }

  // ---- 오디오 밸런스 + TTS 설정 ----
  const audioConfig = await readAudioConfig(projectId);
  const ttsConfig = await readTtsConfig(projectId);
  const videoDur = await probeDuration(captioned);

  // ---- TTS 나레이션 준비 + 합성 ----
  // 옵션(source/genMode)에 따라 segments 를 만들고 각 segment 를 WAV 로 합성.
  // 합성은 Gemini 키가 필요 → 없으면 TTS 를 막지 말고 조용히 건너뛴다.
  let ttsLayers: TtsLayer[] = [];
  if (ttsConfig.enabled) {
    if (!config.GEMINI_API_KEY) {
      await appendRawResponse(projectId, { stage: 4, kind: 'tts_skipped_no_key' });
    } else {
      ttsLayers = await synthesizeNarrationLayers(projectId, ttsConfig, videoDur);
    }
  }

  // ---- 오디오 밸런스 결정 ----
  // origVol: 원본 영상 소리 게인 (mute=0 / low / full). loudnorm 이 마지막에 평준화.
  const hasTts = ttsLayers.length > 0;
  const hasBgm = bgms.length > 0;
  let origVol = ORIGINAL_VOLUME_GAIN[audioConfig.originalVolume];
  // 안전장치: TTS 도 BGM 도 없는데 원본까지 mute 면 무음 영상이 된다 → 원본을 살린다.
  const fallbackForcedAudible = !hasTts && !hasBgm && origVol === 0;
  if (fallbackForcedAudible) origVol = ORIGINAL_VOLUME_GAIN.full;
  // TTS 가 메인 음성일 때 원본은 항상 mute (origVol 무시).
  const originalAudible = !hasTts && origVol > 0;

  await appendRawResponse(projectId, {
    stage: 4, kind: 'audio_plan',
    noise_muted_ranges: noiseRanges.length, ranges: noiseRanges,
    bgm_source: hasBgm ? bgmSource : 'none',
    original_volume: audioConfig.originalVolume, original_audible: originalAudible,
    tts_enabled: ttsConfig.enabled, tts_source: ttsConfig.source, tts_gen_mode: ttsConfig.genMode,
    tts_layers: ttsLayers.length,
  });

  // ---- 입력 순서 결정: [0]=captioned, ([1]=bgm), ([n..]=tts) ----
  const ffInputs: string[] = [captioned];
  let bgmInputIdx: number | null = null;
  let ttsInputStart: number | null = null;

  let bgmStart = 0;
  let bgmFile = '';
  if (hasBgm) {
    bgmFile = bgms[0];
    bgmInputIdx = ffInputs.length;
    ffInputs.push(bgmFile);
    bgmStart = await pickBgmStartOffset(bgmFile, videoDur, audioProfile);
    await appendRawResponse(projectId, {
      stage: 4, kind: 'bgm_segment_selection',
      bgm_path: bgmFile, start_offset_sec: bgmStart,
      video_duration_sec: videoDur, profile: audioProfile,
    });
  }
  if (hasTts) {
    ttsInputStart = ffInputs.length;
    for (const tl of ttsLayers) ffInputs.push(tl.path);
  }

  // ---- filter_complex 구성 ----
  const parts: string[] = [];

  // 1) 원본 영상 오디오 처리 ([srcA])
  //    - TTS 메인 음성 → 원본 mute (volume=0) 후 mix 에 합류 (silent input)
  //    - 원본 살림(originalAudible) → 노이즈 구간 추가 mute + origVol 스케일
  //    - BGM only (원본 mute, TTS 없음) → [srcA] 자체를 만들지 않는다
  //      (만들어두면 어떤 출력에도 연결되지 않아 ffmpeg 가 에러를 낸다)
  if (hasTts) {
    parts.push(`[0:a]volume=0[srcA]`);
  } else if (originalAudible) {
    // 노이즈 구간 mute 는 "다른 음원(BGM 등)이 있을 때" 발화 없는 컷의 잡음을 죽이는 용도.
    // 안전장치로 원본이 유일 음원이 된 경우엔, 모든 컷이 noise 로 판정되면 전체가 0 이 되어
    // 무음 영상이 되므로 noise-mute 를 적용하지 않고 원본을 그대로 살린다.
    if (noiseEnableExpr && !fallbackForcedAudible) {
      parts.push(`[0:a]volume=0:enable='${noiseEnableExpr}',volume=${origVol.toFixed(2)}[srcA]`);
    } else {
      parts.push(`[0:a]volume=${origVol.toFixed(2)}[srcA]`);
    }
  }

  // 2) TTS layer 들 → atempo 보정 + dynaudnorm (segment 음량 일정화) + volume 부스트 + adelay 배치 → ttsLabel 하나로 모음.
  //    atempo 는 0.5~2.0 범위에서 한 번에 적용 가능.
  //    dynaudnorm 으로 Gemini TTS preview 의 segment 간 음량 차이를 평준화 → 일관된 들림.
  //    volume 부스트는 BGM 대비 명확히 들리도록 (loudnorm 이 마지막에 전체 평준화).
  let ttsLabel = '';
  if (hasTts && ttsInputStart !== null) {
    for (let i = 0; i < ttsLayers.length; i++) {
      const tl = ttsLayers[i];
      const startMs = Math.max(0, Math.round(tl.start * 1000));
      const idx = ttsInputStart + i;
      const chain: string[] = [];
      if (tl.atempo > 1.01) chain.push(`atempo=${tl.atempo.toFixed(3)}`);
      chain.push(TTS_DYNAUDNORM);
      chain.push(`volume=${TTS_VOLUME_BOOST.toFixed(2)}`);
      if (startMs > 0) chain.push(`adelay=${startMs}|${startMs}`);
      parts.push(`[${idx}:a]${chain.join(',')}[tts${i}]`);
    }
    if (ttsLayers.length === 1) {
      ttsLabel = '[tts0]';
    } else {
      const lab = ttsLayers.map((_, i) => `[tts${i}]`).join('');
      parts.push(`${lab}amix=inputs=${ttsLayers.length}:duration=longest:dropout_transition=0[ttsAll]`);
      ttsLabel = '[ttsAll]';
    }
  }

  // 3) BGM 처리 + (선택) sidechain ducking
  //    - TTS 모드: TTS 가 trigger, BGM 작게 깔개.
  //    - 원본 살림 모드: 원본 발화가 trigger, BGM 중간 → 발화 중 dip.
  //    - BGM only 모드: 원본이 mute 라 duck 대상이 없음 → BGM 단독, 크게.
  if (hasBgm && bgmInputIdx !== null) {
    const bgmVol = hasTts ? BGM_VOLUME_WITH_TTS
      : originalAudible ? BGM_VOLUME_NO_TTS
        : BGM_VOLUME_SOLO;
    parts.push(
      `[${bgmInputIdx}:a]atrim=start=${bgmStart.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `aloop=loop=-1:size=2e9,atrim=duration=${videoDur.toFixed(3)},volume=${bgmVol.toFixed(2)}[bgm0]`
    );
    if (hasTts) {
      // TTS 가 BGM 의 ducking trigger. ratio 15 로 발화 중 BGM 깊게 누르고,
      // release 180ms 로 발화 끝나면 빠르게 복귀해서 BGM 이 끊김 없이 흐름.
      parts.push(`${ttsLabel}asplit=2[ttsMix][ttsTrig]`);
      parts.push(`[bgm0][ttsTrig]sidechaincompress=threshold=0.03:ratio=15:attack=4:release=180[bgmDuck]`);
    } else if (originalAudible) {
      // 원본 voice 가 trigger (BGM 이 원본 위에 깔리고 발화 중 dip)
      parts.push(`[srcA]asplit=2[srcMix][srcTrig]`);
      parts.push(`[bgm0][srcTrig]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[bgmDuck]`);
    }
    // else: BGM only → [bgm0] 를 그대로 최종 mix 로.
  }

  // 4) 최종 mix
  let mode: 'voice_only' | 'bgm_mixed' | 'bgm_only' | 'tts_only' | 'tts_bgm_mixed';
  if (hasTts && hasBgm) {
    parts.push(`[srcA][ttsMix][bgmDuck]amix=inputs=3:duration=first:dropout_transition=0,${LOUDNORM}[aout]`);
    mode = 'tts_bgm_mixed';
  } else if (hasTts) {
    parts.push(`[srcA]${ttsLabel}amix=inputs=2:duration=first:dropout_transition=0,${LOUDNORM}[aout]`);
    mode = 'tts_only';
  } else if (hasBgm && originalAudible) {
    parts.push(`[srcMix][bgmDuck]amix=inputs=2:duration=first:dropout_transition=0,${LOUDNORM}[aout]`);
    mode = 'bgm_mixed';
  } else if (hasBgm) {
    // BGM only — 원본 mute, ducking 없음. BGM 단독으로 loudnorm.
    parts.push(`[bgm0]${LOUDNORM}[aout]`);
    mode = 'bgm_only';
  } else {
    // 원본 only (BGM 없음). originalAudible 이므로 [srcA] 존재.
    parts.push(`[srcA]${LOUDNORM}[aout]`);
    mode = 'voice_only';
  }

  await runFfmpeg([
    '-y',
    ...ffInputs.flatMap(f => ['-i', f]),
    '-filter_complex', parts.join(';'),
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    finalPath,
  ]);

  return {
    ok: true,
    mode,
    bgm: hasBgm ? { source: bgmSource, ...archiveMeta } : undefined,
    reference_bgm: refBgm && refBgm.status !== 'no_token'
      ? {
          status: refBgm.status,
          title: refBgm.identity?.title,
          artist: refBgm.identity?.artist,
          album: refBgm.identity?.album,
          release_date: refBgm.identity?.release_date,
          genres: refBgm.identity?.genres,
          song_link: refBgm.identity?.song_link,
          spotify_url: refBgm.identity?.spotify_url,
          apple_url: refBgm.identity?.apple_url,
        }
      : undefined,
    tts: hasTts ? {
      voice: ttsConfig.voice || DEFAULT_VOICE,
      layers: ttsLayers.length,
      corrections: ttsLayers.filter(l => l.atempo > 1.01).length,
    } : undefined,
    noise_muted_ranges: noiseRanges.length,
  };
}

// ============================================================
// 나레이션 개요 준비 + segment 별 TTS 합성 → TtsLayer[] 반환.
// runStage4 에서 분리해 오디오 믹스 로직과 합성 로직을 떼어놓는다.
// 실패해도 [] 를 반환 → 영상 전체를 죽이지 않고 TTS 없이 진행.
// ============================================================
async function synthesizeNarrationLayers(
  projectId: string,
  ttsConfig: TtsConfig,
  videoDur: number,
): Promise<TtsLayer[]> {
  // 자동 생성은 OpenAI 로 나레이션을 쓴다 → 키 없으면 명시적으로 스킵 (silent fail 방지).
  if (ttsConfig.source === 'generate' && ttsConfig.genMode === 'auto' && !config.OPENAI_API_KEY) {
    await appendRawResponse(projectId, { stage: 4, kind: 'tts_skipped_no_openai_key' });
    return [];
  }

  // 나레이션 개요 준비. LLM(자동) 실패 등으로 throw 해도 TTS 없이 진행하되,
  // 직전 성공 run 의 outline 이 남아 표시되지 않도록 빈 outline 으로 덮어쓴다.
  let segments: NarrationSegment[] = [];
  try {
    const prep = await prepareNarrationOutline(projectId, ttsConfig, videoDur);
    segments = prep.segments;
    await appendRawResponse(projectId, {
      stage: 4, kind: 'tts_outline_prepared',
      source: ttsConfig.source, gen_mode: ttsConfig.genMode,
      generated_model: prep.generatedModel, segments: segments.length,
    });
  } catch (e: any) {
    await appendRawResponse(projectId, {
      stage: 4, kind: 'tts_outline_failed',
      source: ttsConfig.source, gen_mode: ttsConfig.genMode,
      error: e?.message || String(e),
    });
    await writeTtsOutline(projectId, {
      generated_at: new Date().toISOString(),
      generated_model: 'failed', total_duration: videoDur,
      segments: [], approved: true, approved_at: new Date().toISOString(),
      last_synthesis: null,
    });
    return [];
  }

  if (segments.length === 0) return [];

  const voice = ttsConfig.voice || DEFAULT_VOICE;
  const dir = ARTIFACTS.ttsAudioDir(projectId);
  await ensureDir(dir);
  for (const f of (await fs.readdir(dir).catch(() => []))) {
    await fs.rm(path.join(dir, f), { force: true });
  }

  const layers: TtsLayer[] = [];
  const correctionNotes: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const outPath = path.join(dir, `seg_${String(i).padStart(4, '0')}.wav`);
    const slotDur = Math.max(0.05, seg.output_end - seg.output_start);
    try {
      const r = await synthesizeTtsToWav(seg.text, outPath, { voice });
      // slot 보다 길면 atempo 로 압축 (안전 상한 2.0).
      let atempo = 1.0;
      if (r.durationSec > slotDur * 1.02) {
        atempo = Math.min(2.0, r.durationSec / slotDur);
        correctionNotes.push(
          `segment #${i} (cut=${seg.cut_index}): tts=${r.durationSec.toFixed(2)}s > slot=${slotDur.toFixed(2)}s → atempo=${atempo.toFixed(2)}`
        );
      }
      layers.push({ start: seg.output_start, path: outPath, duration: r.durationSec, atempo, slotDuration: slotDur });
      await appendRawResponse(projectId, {
        stage: 4, kind: 'tts_segment',
        segment_index: i, cut_index: seg.cut_index,
        voice, text_chars: seg.text.length,
        tts_duration_sec: r.durationSec, slot_duration_sec: slotDur, atempo,
      });
    } catch (e: any) {
      await appendRawResponse(projectId, {
        stage: 4, kind: 'tts_segment_failed',
        segment_index: i, error: e?.message || String(e),
      });
    }
  }

  // 합성 보정 기록 (디버깅용)
  await writeTtsOutline(projectId, {
    last_synthesis: { at: new Date().toISOString(), notes: correctionNotes },
  });

  return layers;
}

async function pickBgmStartOffset(filePath: string, videoDur: number, profile: AudioProfile): Promise<number> {
  const bgmDur = await probeDuration(filePath);
  if (!isFinite(bgmDur) || bgmDur <= 0) return 0;
  if (bgmDur <= videoDur + 3) return 0;

  const windowDur = Math.max(4, Math.min(12, videoDur, bgmDur - 1));
  const latestStart = Math.max(0, bgmDur - windowDur - 1);
  if (latestStart <= 0) return 0;

  const candidates = buildBgmStartCandidates(latestStart, bgmDur);
  const targetMean = targetMeanVolume(profile);
  const rows: { start: number; mean: number; max: number; score: number }[] = [];

  for (const start of candidates) {
    const stats = await measureAudioWindow(filePath, start, windowDur);
    if (!stats) continue;
    const tooQuietPenalty = stats.mean < -38 ? 20 : 0;
    const clippingPenalty = stats.max > -0.5 ? 8 : 0;
    const introPenalty = start < Math.min(8, bgmDur * 0.08) ? 6 : 0;
    const score =
      Math.abs(stats.mean - targetMean) +
      Math.max(0, -18 - stats.max) * 0.2 +
      tooQuietPenalty +
      clippingPenalty +
      introPenalty;
    rows.push({ start, mean: stats.mean, max: stats.max, score });
  }

  if (rows.length === 0) return Math.min(8, latestStart);
  rows.sort((a, b) => a.score - b.score || a.start - b.start);
  return round3(rows[0].start);
}

function buildBgmStartCandidates(latestStart: number, bgmDur: number): number[] {
  const starts = [
    0,
    Math.min(8, latestStart),
    latestStart * 0.18,
    latestStart * 0.32,
    latestStart * 0.48,
    latestStart * 0.64,
    latestStart * 0.8,
  ];
  if (bgmDur > 90) starts.push(Math.min(45, latestStart), Math.min(60, latestStart));
  return Array.from(new Set(starts.map(round3).filter(s => s >= 0 && s <= latestStart)))
    .sort((a, b) => a - b);
}

function targetMeanVolume(profile: AudioProfile): number {
  const energy = norm(profile.bgm_energy);
  const tempo = norm(profile.bgm_tempo);
  const mood = norm(profile.bgm_mood);
  if (energy.includes('high') || energy.includes('energetic') || tempo.includes('fast') || mood.includes('upbeat')) return -18;
  if (energy.includes('low') || tempo.includes('slow') || mood.includes('calm') || mood.includes('chill')) return -27;
  return -22;
}

async function measureAudioWindow(filePath: string, start: number, duration: number): Promise<{ mean: number; max: number } | null> {
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-ss', start.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', filePath,
    '-vn',
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]).catch(e => ({ stdout: '', stderr: String(e?.message ?? e) } as any));

  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  if (!mean || !max) return null;
  return { mean: parseFloat(mean[1]), max: parseFloat(max[1]) };
}

async function fileOk(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listBgmFiles(projectId: string): Promise<string[]> {
  const dir = bgmDir(projectId);
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => !f.startsWith('.')).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

// 레퍼런스 영상에서 실제 BGM 을 지문인식. 토큰 없거나 실패해도 파이프라인을 막지 않는다.
async function identifyReferenceBgmSafe(projectId: string): Promise<BgmIdentifyResult> {
  try {
    const dir = referenceDir(projectId);
    const files = (await fs.readdir(dir).catch(() => [])).filter(f => !f.startsWith('.'));
    if (files.length === 0) return { status: 'error', error: '레퍼런스 영상 없음' };
    const refFile = path.join(dir, files[0]);
    return await identifyReferenceBgm(refFile, path.join(stageDir(projectId, 4), 'tmp'));
  } catch (e: any) {
    return { status: 'error', error: e?.message || String(e) };
  }
}

// 노이즈 구간들을 FFmpeg expression 으로 변환:
// between(t,s1,e1)+between(t,s2,e2)+...
// 각 항은 구간 안에서 1, 밖에서 0. 합이 1+ 면 enable.
function buildEnableExpr(ranges: { start: number; end: number }[]): string | null {
  if (ranges.length === 0) return null;
  return ranges
    .map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`)
    .join('+');
}

function norm(s?: string): string {
  return String(s ?? '').toLowerCase().trim();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
