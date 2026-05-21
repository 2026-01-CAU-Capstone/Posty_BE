# ============================================================
# 한글 OFL 폰트 번들 다운로드 스크립트
# - 시스템 폰트에 의존하지 않고 FFmpeg subtitles 의 fontsdir 옵션으로 로드
# - Pretendard (orioncactus) + Google Fonts 한글 OFL 폰트
# - 실행: powershell -ExecutionPolicy Bypass -File scripts\install-fonts.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FontsDir  = Join-Path (Split-Path -Parent $ScriptDir) 'assets\fonts'
New-Item -ItemType Directory -Force -Path $FontsDir | Out-Null

Write-Host "[install-fonts] target: $FontsDir"

# (url, filename)
$GoogleBase = 'https://raw.githubusercontent.com/google/fonts/main/ofl'
$PretendardBase = 'https://github.com/orioncactus/pretendard/raw/main/packages/pretendard/dist/public/static'

$Fonts = @(
    # Pretendard (modern sans, 3 weights)
    @{ url = "$PretendardBase/Pretendard-Regular.otf"; file = 'Pretendard-Regular.otf' },
    @{ url = "$PretendardBase/Pretendard-Bold.otf";    file = 'Pretendard-Bold.otf' },
    @{ url = "$PretendardBase/Pretendard-Black.otf";   file = 'Pretendard-Black.otf' },

    # NanumGothic family (general purpose sans)
    @{ url = "$GoogleBase/nanumgothic/NanumGothic-Regular.ttf";   file = 'NanumGothic-Regular.ttf' },
    @{ url = "$GoogleBase/nanumgothic/NanumGothic-Bold.ttf";      file = 'NanumGothic-Bold.ttf' },
    @{ url = "$GoogleBase/nanumgothic/NanumGothic-ExtraBold.ttf"; file = 'NanumGothic-ExtraBold.ttf' },

    # GothicA1 (alternative sans with many weights)
    @{ url = "$GoogleBase/gothica1/GothicA1-Regular.ttf"; file = 'GothicA1-Regular.ttf' },
    @{ url = "$GoogleBase/gothica1/GothicA1-Bold.ttf";    file = 'GothicA1-Bold.ttf' },
    @{ url = "$GoogleBase/gothica1/GothicA1-Black.ttf";   file = 'GothicA1-Black.ttf' },

    # GowunDodum (rounded clean sans)
    @{ url = "$GoogleBase/gowundodum/GowunDodum-Regular.ttf"; file = 'GowunDodum-Regular.ttf' },

    # Sunflower (minimal sans, 3 weights)
    @{ url = "$GoogleBase/sunflower/Sunflower-Light.ttf";  file = 'Sunflower-Light.ttf' },
    @{ url = "$GoogleBase/sunflower/Sunflower-Medium.ttf"; file = 'Sunflower-Medium.ttf' },
    @{ url = "$GoogleBase/sunflower/Sunflower-Bold.ttf";   file = 'Sunflower-Bold.ttf' },

    # NanumMyeongjo (elegant serif)
    @{ url = "$GoogleBase/nanummyeongjo/NanumMyeongjo-Regular.ttf";   file = 'NanumMyeongjo-Regular.ttf' },
    @{ url = "$GoogleBase/nanummyeongjo/NanumMyeongjo-Bold.ttf";      file = 'NanumMyeongjo-Bold.ttf' },
    @{ url = "$GoogleBase/nanummyeongjo/NanumMyeongjo-ExtraBold.ttf"; file = 'NanumMyeongjo-ExtraBold.ttf' },

    # GowunBatang (modern serif)
    @{ url = "$GoogleBase/gowunbatang/GowunBatang-Regular.ttf"; file = 'GowunBatang-Regular.ttf' },
    @{ url = "$GoogleBase/gowunbatang/GowunBatang-Bold.ttf";    file = 'GowunBatang-Bold.ttf' },

    # SongMyung (vintage / traditional serif)
    @{ url = "$GoogleBase/songmyung/SongMyung-Regular.ttf"; file = 'SongMyung-Regular.ttf' },

    # Display / Impact / Bold
    @{ url = "$GoogleBase/blackhansans/BlackHanSans-Regular.ttf"; file = 'BlackHanSans-Regular.ttf' },
    @{ url = "$GoogleBase/dohyeon/DoHyeon-Regular.ttf";            file = 'DoHyeon-Regular.ttf' },
    @{ url = "$GoogleBase/jua/Jua-Regular.ttf";                    file = 'Jua-Regular.ttf' },
    @{ url = "$GoogleBase/yeonsung/YeonSung-Regular.ttf";          file = 'YeonSung-Regular.ttf' },
    @{ url = "$GoogleBase/stylish/Stylish-Regular.ttf";            file = 'Stylish-Regular.ttf' },
    @{ url = "$GoogleBase/gugi/Gugi-Regular.ttf";                  file = 'Gugi-Regular.ttf' },

    # Handwritten - neat / pen
    @{ url = "$GoogleBase/nanumpenscript/NanumPenScript-Regular.ttf"; file = 'NanumPenScript-Regular.ttf' },
    @{ url = "$GoogleBase/gaegu/Gaegu-Regular.ttf";                   file = 'Gaegu-Regular.ttf' },
    @{ url = "$GoogleBase/gaegu/Gaegu-Bold.ttf";                      file = 'Gaegu-Bold.ttf' },
    @{ url = "$GoogleBase/gaegu/Gaegu-Light.ttf";                     file = 'Gaegu-Light.ttf' },
    @{ url = "$GoogleBase/singleday/SingleDay-Regular.ttf";           file = 'SingleDay-Regular.ttf' },
    @{ url = "$GoogleBase/himelody/HiMelody-Regular.ttf";             file = 'HiMelody-Regular.ttf' },
    @{ url = "$GoogleBase/poorstory/PoorStory-Regular.ttf";           file = 'PoorStory-Regular.ttf' },

    # Handwritten - brush / decorative
    @{ url = "$GoogleBase/nanumbrushscript/NanumBrushScript-Regular.ttf"; file = 'NanumBrushScript-Regular.ttf' },
    @{ url = "$GoogleBase/kiranghaerang/KirangHaerang-Regular.ttf";       file = 'KirangHaerang-Regular.ttf' },
    @{ url = "$GoogleBase/gamjaflower/GamjaFlower-Regular.ttf";           file = 'GamjaFlower-Regular.ttf' },
    @{ url = "$GoogleBase/dokdo/Dokdo-Regular.ttf";                       file = 'Dokdo-Regular.ttf' },
    @{ url = "$GoogleBase/cutefont/CuteFont-Regular.ttf";                 file = 'CuteFont-Regular.ttf' },
    @{ url = "$GoogleBase/blackandwhitepicture/BlackAndWhitePicture-Regular.ttf"; file = 'BlackAndWhitePicture-Regular.ttf' },
    @{ url = "$GoogleBase/eastseadokdo/EastSeaDokdo-Regular.ttf";         file = 'EastSeaDokdo-Regular.ttf' }
)

$total = $Fonts.Count
$ok = 0
$skip = 0
$fail = 0

for ($i = 0; $i -lt $total; $i++) {
    $f = $Fonts[$i]
    $dst = Join-Path $FontsDir $f.file
    $num = '{0,3}/{1}' -f ($i + 1), $total

    if (Test-Path $dst) {
        $sz = (Get-Item $dst).Length
        if ($sz -gt 1024) {
            Write-Host "$num skip   $($f.file)  ($([math]::Round($sz/1KB)) KB)"
            $skip++
            continue
        }
    }

    try {
        Invoke-WebRequest -Uri $f.url -OutFile $dst -UseBasicParsing -ErrorAction Stop
        $sz = (Get-Item $dst).Length
        if ($sz -lt 1024) { throw "downloaded file too small: $sz bytes" }
        Write-Host "$num ok     $($f.file)  ($([math]::Round($sz/1KB)) KB)"
        $ok++
    } catch {
        Write-Host "$num FAIL   $($f.file)  -- $($_.Exception.Message)" -ForegroundColor Red
        if (Test-Path $dst) { Remove-Item $dst -Force }
        $fail++
    }
}

Write-Host ""
Write-Host "[install-fonts] done. ok=$ok skip=$skip fail=$fail total=$total"
if ($fail -gt 0) { exit 1 }
