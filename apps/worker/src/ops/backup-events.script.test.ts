import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * scripts/backup-events.sh 를 **실제로 실행**한다. 가짜 psql 을 PATH 앞에 둬서
 * 데이터베이스에는 닿지 않는다.
 *
 * 이 테스트가 존재하는 이유: 이 스크립트는 shellcheck 와 세 번의 코드 리뷰를
 * 통과했지만 한 번도 실행된 적이 없었고, 첫 실행에서 정상 경로가 즉시 죽었다
 * (`PIPESTATUS[1]: unbound variable` — 대입문이 PIPESTATUS 를 덮어쓰는 bash
 * 런타임 의미론). 정적 검증으로는 잡히지 않는 종류라, 스크립트를 고칠 때마다
 * 정상 경로와 각 실패 경로를 실제로 한 번씩 밟는 장치가 필요하다.
 *
 * 백업에서 가장 나쁜 실패는 "초록인데 데이터가 틀림" 이므로, 실패 경로마다
 * 비정상 종료와 **산출물 삭제**를 함께 확인한다.
 */
const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '../../../../scripts/backup-events.sh')

// count(*) 질의와 \copy 를 인자로 구분해 환경변수대로 응답하는 가짜 psql.
// seq 대신 산술 루프를 쓴다 — macOS 의 `seq 1 0` 은 GNU 와 달리 "1 0" 을
// 출력해서, 0행을 요청한 경우에 2행을 내보낸다.
const STUB = `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"count(*)"* ]]; then
  [ -n "\${STUB_COUNT_FAIL:-}" ] && { echo "psql: connection refused" >&2; exit 2; }
  echo "\${STUB_COUNT:-5}"; exit 0
fi
if [[ "$args" == *"\\\\copy"* ]]; then
  echo "id,source_id,external_id,occurred_at,first_seen_at,title,url,corp_name,ticker,market,verdict,tier,rule,raw"
  for ((i=1; i<=\${STUB_ROWS:-5}; i++)); do echo "$i,dart,e$i,,2026-10-01,t$i,u,c,000000,Y,pass,high,r,{}"; done
  exit "\${STUB_COPY_EXIT:-0}"
fi
echo "unexpected psql call: $args" >&2; exit 99
`

let dir: string
let binDir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-script-'))
  binDir = join(dir, 'bin')
  writeFileSync(join(dir, '.keep'), '')
  spawnSync('mkdir', ['-p', binDir])
  writeFileSync(join(binDir, 'psql'), STUB)
  chmodSync(join(binDir, 'psql'), 0o755)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(env: Record<string, string>) {
  const out = join(dir, 'out.csv.gz')
  rmSync(out, { force: true })
  const r = spawnSync('bash', [SCRIPT, out], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      // 가짜 psql 이 받으므로 실제 접속은 일어나지 않는다.
      DATABASE_URL: 'postgresql://stub',
      ...env,
    },
    encoding: 'utf8',
  })
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, artifactLeft: existsSync(out) }
}

describe('scripts/backup-events.sh (가짜 psql 로 실제 실행)', () => {
  it('정상 — 덤프 행 수가 사전 카운트와 같으면 성공하고 산출물을 남긴다', () => {
    const r = run({ STUB_COUNT: '5', STUB_ROWS: '5' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.artifactLeft).toBe(true)
    expect(r.stdout).toContain('5 rows')
  })

  it('동시 삽입 — 덤프가 사전 카운트보다 많아도 성공한다', () => {
    const r = run({ STUB_COUNT: '5', STUB_ROWS: '7' })
    expect(r.status).toBe(0)
    expect(r.artifactLeft).toBe(true)
  })

  it('덤프 psql 이 실패하면 실패하고 산출물을 지운다 — PIPESTATUS 회귀 지점', () => {
    const r = run({ STUB_COUNT: '5', STUB_ROWS: '5', STUB_COPY_EXIT: '2' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('psql=2')
    expect(r.stderr).not.toContain('unbound variable')
    expect(r.artifactLeft).toBe(false)
  })

  it('상류 절단 — 덤프가 사전 카운트보다 적으면 실패하고 산출물을 지운다', () => {
    const r = run({ STUB_COUNT: '10', STUB_ROWS: '3' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('3')
    expect(r.artifactLeft).toBe(false)
  })

  it('헤더만 있는 덤프는 성공으로 보고하지 않는다', () => {
    const r = run({ STUB_COUNT: '0', STUB_ROWS: '0' })
    expect(r.status).not.toBe(0)
    expect(r.artifactLeft).toBe(false)
  })

  it('사전 카운트 연결이 실패하면 덤프를 시도하지 않고 실패한다', () => {
    const r = run({ STUB_COUNT_FAIL: '1' })
    expect(r.status).not.toBe(0)
    expect(r.artifactLeft).toBe(false)
  })
})
