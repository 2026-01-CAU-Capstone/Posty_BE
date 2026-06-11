#!/usr/bin/env bash
# ============================================================
# 한글 OFL 폰트 번들 다운로드 (install-fonts.ps1 의 Linux/bash 버전)
# - 시스템 폰트에 의존하지 않고 FFmpeg subtitles 의 fontsdir 로 로드
# - Docker 이미지 빌드 단계 / 리눅스 서버에서 사용
# - 실행: bash scripts/install-fonts.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FONTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/assets/fonts"
mkdir -p "$FONTS_DIR"
echo "[install-fonts] target: $FONTS_DIR"

GF="https://raw.githubusercontent.com/google/fonts/main/ofl"
PRE="https://github.com/orioncactus/pretendard/raw/main/packages/pretendard/dist/public/static"

# 각 항목: "<filename>|<url>"
FONTS=(
  "Pretendard-Regular.otf|$PRE/Pretendard-Regular.otf"
  "Pretendard-Bold.otf|$PRE/Pretendard-Bold.otf"
  "Pretendard-Black.otf|$PRE/Pretendard-Black.otf"
  "NanumGothic-Regular.ttf|$GF/nanumgothic/NanumGothic-Regular.ttf"
  "NanumGothic-Bold.ttf|$GF/nanumgothic/NanumGothic-Bold.ttf"
  "NanumGothic-ExtraBold.ttf|$GF/nanumgothic/NanumGothic-ExtraBold.ttf"
  "GothicA1-Regular.ttf|$GF/gothica1/GothicA1-Regular.ttf"
  "GothicA1-Bold.ttf|$GF/gothica1/GothicA1-Bold.ttf"
  "GothicA1-Black.ttf|$GF/gothica1/GothicA1-Black.ttf"
  "GowunDodum-Regular.ttf|$GF/gowundodum/GowunDodum-Regular.ttf"
  "Sunflower-Light.ttf|$GF/sunflower/Sunflower-Light.ttf"
  "Sunflower-Medium.ttf|$GF/sunflower/Sunflower-Medium.ttf"
  "Sunflower-Bold.ttf|$GF/sunflower/Sunflower-Bold.ttf"
  "NanumMyeongjo-Regular.ttf|$GF/nanummyeongjo/NanumMyeongjo-Regular.ttf"
  "NanumMyeongjo-Bold.ttf|$GF/nanummyeongjo/NanumMyeongjo-Bold.ttf"
  "NanumMyeongjo-ExtraBold.ttf|$GF/nanummyeongjo/NanumMyeongjo-ExtraBold.ttf"
  "GowunBatang-Regular.ttf|$GF/gowunbatang/GowunBatang-Regular.ttf"
  "GowunBatang-Bold.ttf|$GF/gowunbatang/GowunBatang-Bold.ttf"
  "SongMyung-Regular.ttf|$GF/songmyung/SongMyung-Regular.ttf"
  "BlackHanSans-Regular.ttf|$GF/blackhansans/BlackHanSans-Regular.ttf"
  "DoHyeon-Regular.ttf|$GF/dohyeon/DoHyeon-Regular.ttf"
  "Jua-Regular.ttf|$GF/jua/Jua-Regular.ttf"
  "YeonSung-Regular.ttf|$GF/yeonsung/YeonSung-Regular.ttf"
  "Stylish-Regular.ttf|$GF/stylish/Stylish-Regular.ttf"
  "Gugi-Regular.ttf|$GF/gugi/Gugi-Regular.ttf"
  "NanumPenScript-Regular.ttf|$GF/nanumpenscript/NanumPenScript-Regular.ttf"
  "Gaegu-Regular.ttf|$GF/gaegu/Gaegu-Regular.ttf"
  "Gaegu-Bold.ttf|$GF/gaegu/Gaegu-Bold.ttf"
  "Gaegu-Light.ttf|$GF/gaegu/Gaegu-Light.ttf"
  "SingleDay-Regular.ttf|$GF/singleday/SingleDay-Regular.ttf"
  "HiMelody-Regular.ttf|$GF/himelody/HiMelody-Regular.ttf"
  "PoorStory-Regular.ttf|$GF/poorstory/PoorStory-Regular.ttf"
  "NanumBrushScript-Regular.ttf|$GF/nanumbrushscript/NanumBrushScript-Regular.ttf"
  "KirangHaerang-Regular.ttf|$GF/kiranghaerang/KirangHaerang-Regular.ttf"
  "GamjaFlower-Regular.ttf|$GF/gamjaflower/GamjaFlower-Regular.ttf"
  "Dokdo-Regular.ttf|$GF/dokdo/Dokdo-Regular.ttf"
  "CuteFont-Regular.ttf|$GF/cutefont/CuteFont-Regular.ttf"
  "BlackAndWhitePicture-Regular.ttf|$GF/blackandwhitepicture/BlackAndWhitePicture-Regular.ttf"
  "EastSeaDokdo-Regular.ttf|$GF/eastseadokdo/EastSeaDokdo-Regular.ttf"
)

total=${#FONTS[@]}; ok=0; skip=0; fail=0; i=0
for entry in "${FONTS[@]}"; do
  i=$((i+1))
  file="${entry%%|*}"; url="${entry#*|}"
  dst="$FONTS_DIR/$file"
  num=$(printf '%3d/%d' "$i" "$total")

  if [ -f "$dst" ] && [ "$(stat -c%s "$dst" 2>/dev/null || echo 0)" -gt 1024 ]; then
    echo "$num skip   $file"; skip=$((skip+1)); continue
  fi
  if curl -fsSL --retry 3 -o "$dst" "$url"; then
    sz=$(stat -c%s "$dst" 2>/dev/null || echo 0)
    if [ "$sz" -lt 1024 ]; then echo "$num FAIL   $file (too small: ${sz}B)"; rm -f "$dst"; fail=$((fail+1)); continue; fi
    echo "$num ok     $file ($((sz/1024)) KB)"; ok=$((ok+1))
  else
    echo "$num FAIL   $file"; rm -f "$dst"; fail=$((fail+1))
  fi
done

echo ""
echo "[install-fonts] done. ok=$ok skip=$skip fail=$fail total=$total"
[ "$fail" -gt 0 ] && exit 1 || exit 0
