# JA Office hermes-agent backend (port 9137) — launchd 상시화

로컬 운영 문서. JA Office(포트 3000)가 붙는 hermes-agent JSON-RPC 백엔드를
launchd user agent로 상시 기동한다.

- Label: `dev.ja-office.hermes-backend`
- plist: `~/Library/LaunchAgents/dev.ja-office.hermes-backend.plist`
- 바인드: `127.0.0.1:9137` (dashboard 모드, 고정)
- 도메인: `gui/<uid>`
- `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=10`

앱(포트 3000)은 `ja-office-app-launchd.md`를 본다.

## 구성 요소

| 파일 | 역할 |
|---|---|
| `scripts/start-hermes-backend.sh` | 실제 기동 스크립트. `.env`에서 토큰을 읽어 `HERMES_DASHBOARD_SESSION_TOKEN`으로 넘긴다. |
| `scripts/launchd/install-hermes-backend.sh` | plist 생성 + bootstrap. `--dry-run`은 plist만 출력. |
| `scripts/launchd/uninstall-hermes-backend.sh` | bootout + plist 제거/보존/백업복구. |
| `scripts/launchd/verify-hermes-backend.sh` | 백엔드 범위 검증. 아래 stack 검증기에 위임한다. |
| `scripts/launchd/verify-ja-office-stack.sh` | 앱 + 백엔드 통합 검증. `--restart-test`로 KeepAlive 복구까지 확인. |
| `scripts/launchd/lib.sh` | 두 installer가 공유하는 포트 인수인계 로직. |

## 토큰 취급

plist에는 토큰을 넣지 않는다. `start-hermes-backend.sh`가 실행 시점에
`ja-office/.env`의 `HERMES3D_GATEWAY_TOKEN`을 읽어 환경변수로만 전달한다.
plist는 `PATH`, `HOME`, `JA_OFFICE_ROOT`, `HERMES_BIN`만 담는다.

## launchd 최소 PATH 대응

launchd는 `/usr/bin:/bin:/usr/sbin:/sbin`만 준다. 그래서

- 저장소 경로: `JA_OFFICE_ROOT` 환경변수 → 없으면 스크립트 위치 기준 상위 디렉터리
- hermes 실행 파일: `HERMES_BIN` → 없으면 `$HERMES_HOME/hermes-agent/venv/bin/hermes` → 없으면 `PATH`의 `hermes`

install 스크립트가 설치 시점에 실제 경로를 확인해 plist에 절대경로로 박는다.

## 설치

```bash
cd <repo>/ja-office
bash scripts/launchd/install-hermes-backend.sh --dry-run   # plist 미리보기
bash scripts/launchd/install-hermes-backend.sh             # 설치 + 기동
```

## 재설치와 인수인계

installer는 파일을 하나라도 건드리기 전에 9137을 정리한다. 순서는 이렇다.

1. 9137 LISTEN 프로세스를 분류한다.
2. 우리 것이 아니면 **아무것도 바꾸지 않고** 거부한다.
3. 우리 것이면 bootout 하고, 포트가 풀릴 때까지 최대 20초 기다린다.
4. 그래도 잡고 있으면 **추적 중인 그 PID만** TERM, 안 죽으면 KILL 한다.
5. 15초 더 기다려도 안 풀리면 중단한다. 예전처럼 bootstrap 해놓고
   `BACKEND_PORT_IN_USE`(exit 75) 재시작 루프에 빠지는 일을 막는다.

"우리 것"의 정의는 셋 뿐이다. launchd가 지금 보고하는 PID, 직전 설치가
`logs/launchd-state/dev.ja-office.hermes-backend.pid`에 기록한 PID, 운영자가
`--adopt-pid`로 직접 지목한 PID. 뒤의 둘은 명령줄이 `bin/hermes ... --port 9137`과
맞아야 한다. PID 번호 재사용으로 엉뚱한 프로세스를 죽이지 않기 위해서다.

기존 plist는 `.bak`으로 백업한다.

launchd가 추적하지 못하는 고아 리스너가 9137을 잡고 있으면 이렇게 넘긴다.

```bash
lsof -nP -iTCP:9137 -sTCP:LISTEN            # PID 확인
ps -o pid=,command= -p <PID>                # hermes dashboard 인지 확인
bash scripts/launchd/install-hermes-backend.sh --adopt-pid <PID>
```

PID를 지목하지 않으면 installer는 거부하고 그 PID를 알려준다. 모르는
프로세스를 알아서 죽이는 일은 없다.

## 검증

```bash
bash scripts/launchd/verify-hermes-backend.sh                 # 백엔드 범위
bash scripts/launchd/verify-hermes-backend.sh --restart-test  # 강제 종료 후 복구까지
bash scripts/launchd/verify-ja-office-stack.sh                # 앱 + 백엔드 전체
```

검사 항목:

1. `launchctl print gui/<uid>/dev.ja-office.hermes-backend` loaded
2. `127.0.0.1:9137` LISTEN PID가 **서비스 PID와 정확히 일치** (고아 리스너 탐지)
3. `GET /api/status` → 200
4. `node scripts/probe-gateway-ws.mjs` → `"ok":true` **이면서** `"adapterType":"hermes-agent"`
5. 앱 `http://127.0.0.1:3000/` → 200 (리디렉션 추적)
6. `--restart-test`: 서비스 PID를 kill → 30초 안에 다른 PID로 재기동 → 새 리스너 PID가
   새 서비스 PID와 다시 정확히 일치 → HTTP 200과 probe 재확인

4번에서 `ok:true`만 보면 안 된다. demo 어댑터도 `ok:true`를 준다. 저장된 Studio
프로필이 demo로 되돌아가면 백엔드가 멀쩡해도 브라우저는 HERMES DISCONNECTED가
된다. 그래서 `adapterType`이 `hermes-agent`인지까지 본다. 이 값을 9137로 고정하는
일은 앱 installer가 한다. `ja-office-app-launchd.md`의 "Studio active gateway 고정"을 본다.

`--restart-test`는 추적 중인 서비스 PID만 kill 한다. 남의 프로세스는 건드리지 않는다.

## 로그

```
logs/launchd-hermes-backend-9137.out.log
logs/launchd-hermes-backend-9137.err.log
logs/launchd-state/dev.ja-office.hermes-backend.pid   # 다음 재설치가 인수인계할 PID
```

`ThrottleInterval=10`이므로 크래시 루프여도 10초 간격 이상으로만 재시작한다.

## 제거 / 롤백

```bash
bash scripts/launchd/uninstall-hermes-backend.sh                 # bootout + plist 삭제
bash scripts/launchd/uninstall-hermes-backend.sh --keep-plist    # bootout만
bash scripts/launchd/uninstall-hermes-backend.sh --restore-backup # 직전 plist 복구
```

uninstall도 bootout 뒤 포트를 확인한다. 순서는 이렇다.

1. bootout 전에 launchd가 보고하는 PID를 기억한다.
2. bootout 한다.
3. 그 PID나 기록된 설치 PID가 아직 9137을 잡고 있으면, 명령줄이 맞을 때만 종료한다.
4. 모르는 프로세스가 9137을 잡고 있으면 그냥 둔다. 죽이지 않는다.
5. 우리 고아가 끝내 안 죽으면 **plist를 지우지 않고** exit 1 한다.
   추적할 수 없는 고아를 남기느니 흔적을 남긴다.

`--keep-plist`와 `--restore-backup`의 의미는 그대로다.

## 건드리지 않는 것

- 포트 3000 앱 (별도 label `dev.ja-office.app`)
- 포트 9120 백엔드 (별개 인스턴스)
- Hermes Desktop 임시 backend

이 label 외의 launchd 서비스는 이 스크립트들이 절대 조작하지 않는다.
