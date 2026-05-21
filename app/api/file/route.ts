// 산출물 파일 서빙
// GET /api/file?path=data/projects/xxx/4_final/final.mp4
// 보안: data/projects/ 하위만 허용
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const relPath = req.nextUrl.searchParams.get('path') || '';
  if (!relPath) return new Response('path 누락', { status: 400 });

  const abs = path.resolve(process.cwd(), relPath);
  const allowed = path.resolve(process.cwd(), 'data', 'projects');
  if (!abs.startsWith(allowed)) {
    return new Response('forbidden', { status: 403 });
  }

  if (!fs.existsSync(abs)) return new Response('not found', { status: 404 });

  const stat = fs.statSync(abs);
  if (!stat.isFile()) return new Response('not a file', { status: 400 });

  const ext = path.extname(abs).toLowerCase();
  const contentType =
    ext === '.mp4' ? 'video/mp4' :
    ext === '.mov' ? 'video/quicktime' :
    ext === '.webm' ? 'video/webm' :
    ext === '.mp3' ? 'audio/mpeg' :
    ext === '.json' ? 'application/json; charset=utf-8' :
    'application/octet-stream';

  // Range 요청 지원 (브라우저 video 태그 시킹 위해)
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(abs, { start, end });
      return new Response(stream as any, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': contentType,
        },
      });
    }
  }

  const stream = fs.createReadStream(abs);
  return new Response(stream as any, {
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
    },
  });
}
