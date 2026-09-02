# JA Office 앱 (포트 3000) — launchd 상시화

로컬 운영 문서. JA Office Next.js 앱을 launchd user agent로 상시 기동한다.
크래시가 나도, 로그아웃 뒤 다시 로그인해도 같은 포트로 돌아온다.

- Label: `dev.ja-office.app`
- plist: `~/Library/LaunchAgents/dev.ja-office.app.plist`
- 바인드: `127.0.0.1:3000` (고정, 절대 다른 포트로 옮기지 않는다)
- 실행: `node server/index.js` (production 모드, `npm start`와 같은 명령)
- 도메인: `gui/<uid>`

백엔드(포트 9137)는 `hermes-backend-launchd.md`를 본다.

## 고정값

| 항목 | 값 |
|---|---|
| `PORT` | `3000` |
| `HOST` | `127.0.0.1` |
| `NODE_ENV` | `production` |
| `RunAtLoad` | `true` |
| `KeepAlive` | `true` |
| `ThrottleInterval` | `10` |

`HOST`가 `127.0.0.1`이라 루프백 밖으로는 열리지 않는다.

## 구성 요소

| 파일 | 역할 |
|---|---|
| `scripts/start-ja-office-app.sh` | 실제 기동 스크립트. 포트·호스트를 고정하고 `node server/index.js`를 exec 한다. |
| `scripts/launchd/install-ja-office-app.sh` | plist 생성 + bootstrap. `--dry-run`은 plist만 출력. |
| `scripts/launchd/uninstall-ja-office-app.sh` | bootout + plist 제거/보존/백업복구. |
| `scripts/launchd/verify-ja-office-stack.sh` | 앱과 백엔드를 함께 검증. |
| `scripts/launchd/lib.sh` | 두 installer가 공유하는 포트 인수인계 로직. |

## 포트를 절대 옮기지 않는다

3000이 막혀 있으면 앱은 실패하고 끝난다. `server/index.js`는 `PORT`만 읽고
빈 포트를 찾지 않는다. launchd는 10초 뒤 다시 시도한다.

`scripts/hermes3d-start.sh`의 수동 기동 경로도 같게 고쳤다. 예전에는 3000이
막히면 조용히 3001로 옮겨 떴다. 지금은 점유 프로세스를 출력하고 종료한다.

## 비밀값 취급

plist에는 토큰을 넣지 않는다. `PATH`, `HOME`, `JA_OFFICE_ROOT`, `NODE_BIN`,
`NODE_ENV`, `PORT`, `HOST`만 담는다. 검증 스크립트도 토큰을 출력하지 않는다.

## launchd 최소 PATH 대응

launchd는 `/usr/bin:/bin:/usr/sbin:/sbin`만 준다. 그래서 install 시점에

- 저장소 경로를 `JA_OFFICE_ROOT`로
- `node` 실제 경로를 `NODE_BIN`으로

절대경로로 확인해 plist에 박는다. `.next` 빌드가 없으면 설치를 거부한다.
프로덕션 서버는 빌드가 있어야 뜨고, 없으면 KeepAlive 재시작 루프가 된다.

## 설치

```bash
cd <repo>/ja-office
npm run build                                        # .next 빌드가 필요하다
bash scripts/launchd/install-ja-office-app.sh --dry-run   # plist 미리보기
bash scripts/launchd/install-ja-office-app.sh             # 설치 + 기동
```

## 재설치와 인수인계

installer는 파일을 하나라도 건드리기 전에 3000을 정리한다. 순서는 이렇다.

1. 3000 LISTEN 프로세스를 분류한다.
2. 우리 것이 아니면 **아무것도 바꾸지 않고** 거부한다.
3. 우리 것이면 bootout 하고, 포트가 풀릴 때까지 최대 20초 기다린다.
4. 그래도 잡고 있으면 **추적 중인 그 PID만** TERM, 안 죽으면 KILL 한다.
5. 15초 더 기다려도 안 풀리면 중단한다. EADDRINUSE 재시작 루프를 만들지 않는다.

"우리 것"의 정의는 셋 뿐이다. launchd가 지금 보고하는 PID, 직전 설치가
`logs/launchd-state/dev.ja-office.app.pid`에 기록한 PID, 운영자가
`--adopt-pid`로 직접 지목한 PID. 뒤의 둘은 명령줄이 `server/index.js`와
맞아야 한다. PID 번호 재사용으로 엉뚱한 프로세스를 죽이지 않기 위해서다.

launchd 밖에서 뜬 detached 앱에서 넘어올 때는 이렇게 한다.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN            # PID 확인
ps -o pid=,command= -p <PID>                # node server/index.js 인지 확인
bash scripts/launchd/install-ja-office-app.sh --adopt-pid <PID>
```

PID를 지목하지 않으면 installer는 거부하고 그 PID를 알려준다. 모르는
프로세스를 알아서 죽이는 일은 없다.

## Studio active gateway 고정

앱이 200을 주고 나면 installer가 한 번, 저장된 Studio active gateway를
`http://localhost:9137`로 고정한다. 공식 경로인 `PUT /api/studio`를
`scripts/apply-studio-gateway.mjs`로 호출한다. 설정 파일을 직접 고치지 않는다.

이게 없으면 저장된 프로필이 demo 어댑터(`ws://localhost:18789`)로 되돌아가고,
브라우저에 HERMES DISCONNECTED가 뜬다. 실제로 그렇게 됐었다. 한 번 고정하면
launchd가 크래시로 재시작하든 재부팅하든 그대로 유지된다.

- 토큰은 helper가 `.env`에서 읽고, 라우트 응답에도 토큰이 없다. installer는
  helper stdout을 통째로 버리고 대상 URL 한 줄만 출력한다.
- `PUT`은 병합이라 다른 설정은 그대로 남는다.
- UI의 어댑터 선택 기능은 건드리지 않는다. 사람이 골라 바꾸는 건 그대로 된다.
- 앱이 90초 안에 200을 못 주거나 고정이 실패하면 installer는 exit 1 한다.
  이때 agent는 이미 설치된 상태다. 원인을 고치고 installer를 다시 돌리면 된다.

백엔드 포트를 바꾸려면 `JA_OFFICE_BACKEND_PORT`를 주고 설치한다.

## 검증

```bash
bash scripts/launchd/verify-ja-office-stack.sh                 # 앱 + 백엔드
bash scripts/launchd/verify-ja-office-stack.sh --app-only
bash scripts/launchd/verify-ja-office-stack.sh --restart-test  # KeepAlive 복구까지
```

검사 항목:

1. 두 label이 `gui/<uid>`에 loaded
2. 3000, 9137 LISTEN PID가 **각 서비스 PID와 정확히 일치** (고아 리스너 탐지)
3. `http://127.0.0.1:3000/` → 200
4. `http://127.0.0.1:9137/api/status` → 200
5. `node scripts/probe-gateway-ws.mjs` → `"ok":true` **이면서** `"adapterType":"hermes-agent"`
6. `--restart-test`: 서비스 PID를 kill → 30초 안에 다른 PID로 재기동 → 새 리스너 PID가
   새 서비스 PID와 다시 정확히 일치 → HTTP 200과 probe 재확인

5번에서 `ok:true`만 보지 않는다. demo 어댑터도 `ok:true`를 준다. 그래서
`adapterType`이 `hermes-agent`인지까지 본다.

`--restart-test`는 추적 중인 서비스 PID만 kill 한다. 포트를 잡고 있는
남의 프로세스는 건드리지 않는다.

## 로그

```
logs/launchd-ja-office-app-3000.out.log
logs/launchd-ja-office-app-3000.err.log
logs/launchd-state/dev.ja-office.app.pid     # 다음 재설치가 인수인계할 PID
```

`ThrottleInterval=10`이라 크래시 루프여도 10초 간격 이상으로만 재시작한다.

## 제거 / 롤백

```bash
bash scripts/launchd/uninstall-ja-office-app.sh                  # bootout + plist 삭제
bash scripts/launchd/uninstall-ja-office-app.sh --keep-plist     # bootout만
bash scripts/launchd/uninstall-ja-office-app.sh --restore-backup # 직전 plist 복구
```

`--restore-backup`은 installer가 남긴 `dev.ja-office.app.plist.bak`을 되돌린다.

uninstall도 bootout 뒤 포트를 확인한다. 순서는 이렇다.

1. bootout 전에 launchd가 보고하는 PID를 기억한다.
2. bootout 한다.
3. 그 PID나 기록된 설치 PID가 아직 3000을 잡고 있으면, 명령줄이 맞을 때만 종료한다.
4. 모르는 프로세스가 3000을 잡고 있으면 그냥 둔다. 죽이지 않는다.
5. 우리 고아가 끝내 안 죽으면 **plist를 지우지 않고** exit 1 한다.
   추적할 수 없는 고아를 남기느니 흔적을 남긴다.

`--keep-plist`와 `--restore-backup`의 의미는 그대로다.

## 건드리지 않는 것

- 포트 9137 백엔드 (별도 label)
- 포트 9120 백엔드, 포트 8642 게이트웨이, 18789 어댑터
- Hermes Desktop

이 label 외의 launchd 서비스는 이 스크립트들이 절대 조작하지 않는다.
