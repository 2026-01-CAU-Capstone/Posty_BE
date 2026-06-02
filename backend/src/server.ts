// ============================================================
// 부트스트랩 진입점.
// 1) cwd 를 repo 루트로 고정 → lib 의 process.cwd() 기반 data/assets 경로가
//    기존 prototype 과 동일하게 resolve 되고, 같은 .env.local 을 재사용한다.
// 2) .env.local / .env 로드.
// 3) (그 "후") 동적 import 로 app 을 로드 — lib/config 가 import 시점에 env 를 읽으므로 순서가 중요.
// ============================================================

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // backend/src
const REPO_ROOT = path.resolve(__dirname, '../..');             // repo 루트
process.chdir(REPO_ROOT);

const dotenv = await import('dotenv');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

// env 로드 후에 app(=lib) 로드
await import('./app');
