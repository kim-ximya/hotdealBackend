# 핫딜 수집 관리자

Windows용 Tauri 2 앱입니다. Rust 수집기가 전용 헤드리스 Chrome으로 아카라이브 핫딜 채널 첫 페이지를 확인하고, 게시글을 JSON으로 저장합니다. 앱 화면은 Windows WebView2에서 실행됩니다. 설치판에는 Electron과 Node.js 런타임이 필요하지 않으며, 수집에는 Google Chrome이 필요합니다.

## 실행

Windows x64 개발 환경에 Node.js 22.12 이상, pnpm, Rust MSVC 도구 체인, Microsoft C++ 빌드 도구, WebView2 및 Chrome을 준비합니다. [Tauri Windows 전제 조건](https://v2.tauri.app/start/prerequisites/)을 참고하세요.

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

프로젝트의 `start-desktop.cmd`로도 열 수 있습니다. 수집을 시작하려면 **서버 시작**을 누르세요. 시작 시 첫 수집을 하고, 이후 기본 3분마다 실행합니다. **지금 수집**은 이미 진행 중인 수집을 중복 실행하지 않습니다. 창을 닫거나 최소화하면 트레이에 머물며, 트레이 메뉴의 **앱 완전 종료**로 자체 수집 작업과 전용 브라우저를 함께 정리합니다. 별도로 실행 중인 호환 서버에 연결한 경우 앱을 닫아도 그 서버는 계속 동작합니다.

- **핫딜 목록:** 최신 ID 순, 50개씩 보기, New 태그, 원문 열기. **표시 항목**에서 제목·작성자·가격·쇼핑몰·배송비·썸네일 등 원하는 항목만 선택해 적용할 수 있습니다. 선택은 앱을 다시 실행해도 유지됩니다. 목록을 새로고침해도 크롤링을 추가 실행하지 않습니다.
  **분류**에서 원하는 게시글만 볼 수 있으며, 관심 품목만 보기와 함께 사용할 수 있습니다. ‘바이럴’은 **전체**에서도 숨깁니다.
- **관심 품목:** 키워드 등록·삭제, 일치하는 글만 보기와 알림. [관심 품목 안내](docs/interests.md).
- **설정:** 수집 간격, 저장 위치, User-Agent, 알림·소리, Windows 로그인 자동 실행. User-Agent 변경은 다음 서버 시작부터 적용합니다.
  **고급**에서 서버 중지 후 저장된 게시글과 썸네일을 초기화할 수 있습니다. 경고창에서 5초가 지나면 확인 버튼이 활성화됩니다.
- **실행 로그:** 별도 창에서 최근 500개 로그, 오류·브라우저 필터, 자동 스크롤과 비우기.
- **알림:** 새 글 저장 후 오른쪽 아래에 표시. 최초 빈 저장소의 첫 수집은 알림의 기준 목록으로 사용합니다. 카드를 오른쪽으로 밀면 닫을 수 있습니다.

수집은 채널 첫 페이지를 주기적으로 확인합니다. 수집 사이 첫 페이지 밖으로 밀려난 글은 누락될 수 있습니다. 보안 확인이나 사이트 구조 변경으로 수집에 실패하면 마지막 정상 JSON을 보존합니다.

가격·쇼핑몰·배송비·100×100 썸네일 주소는 목록에 있는 값을 저장합니다. 게시글 상세 페이지에 추가로 접속하지 않습니다. 썸네일은 별도 파일로 저장해 주소가 만료되어도 표시하며, 이미지에 접근할 수 없거나 기존 글에 아직 새 항목이 없으면 해당 칸은 `—`로 표시합니다.

## 독립 수집 서버와 로컬 API

`pnpm start`는 창 없이 같은 Rust 수집 코어를 실행합니다. 종료는 Ctrl+C입니다. 기본 주소는 `http://127.0.0.1:38471`이며 같은 컴퓨터에서 실행하는 다른 프론트엔드가 사용할 수 있습니다.

| 경로 | 동작 |
| --- | --- |
| `GET /api/articles?limit=100&offset=0` | 저장한 게시글과 페이지 정보. limit는 1~1000 |
| `GET /api/articles/{id}/thumbnail` | 저장한 썸네일 이미지. 없으면 404 |
| `GET /api/status` | 실행·수집·브라우저 상태와 최근 오류 |
| `GET /api/settings` | 현재 수집 간격 |
| `PUT /api/settings` | JSON `{"intervalSeconds":180}`으로 수집 간격 변경 |
| `POST /api/collect` | JSON `{}`을 보내 즉시 수집 요청. 수락 시 202 반환 |

API는 루프백에만 바인딩하고 정확한 Host와 Origin을 검사합니다. 외부 웹페이지에서 접근할 경우 `FRONTEND_ORIGINS`에 정확한 출처를 지정하세요. 앱 화면과 로컬 API는 별도 인터페이스입니다.

`.env.example`에 개발판·독립 서버 설정 예시가 있습니다. `PORT`, `DATA_DIR`, `MAX_ARTICLES`, `SELENIUM_WAIT_SECONDS`, `SELENIUM_CHROME_BINARY`, `SE_MANAGER_PATH`, `FRONTEND_ORIGINS`를 지원합니다. `CRAWL_INTERVAL_SECONDS`와 `SELENIUM_USER_AGENT`는 독립 서버에서만 저장 설정을 재정의합니다. 설치판은 프로젝트의 `.env`를 읽지 않습니다.

## 테스트와 Windows 설치 파일

```powershell
pnpm test
pnpm dist:win
```

실제 Chrome으로 로컬 HTML fixture를 읽고 드라이버 종료까지 확인하려면, 준비 스크립트를 실행한 뒤 아래 테스트를 별도로 실행합니다.

```powershell
node build/prepare-tauri.cjs
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features chrome_reads_a_fixture -- --ignored --nocapture
```

Windows NSIS 설치 파일은 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis`에 생성됩니다. 빌드 준비 스크립트가 UI 자산과 Selenium Manager·라이선스를 복사합니다. 프로젝트의 `.env`, 게시글, 사용자 프로필 및 쿠키는 설치 파일에 넣지 않습니다.

기존 **Electron 1.1.0 → Tauri 2.0.0**은 수동 전환입니다. 구버전 앱을 트레이에서 완전히 종료하고, Windows 시작 항목이 중복되지 않도록 구버전을 제거한 뒤 새 설치 파일을 실행하세요. 게시글과 설정은 기존 `%APPDATA%\HotdealCollector`에서 이어 읽습니다. 개발판은 기존 `.local/desktop`과 `.local/selenium-server`를 사용합니다. 기존 앱을 유지하며 비교할 때는 `HOTDEAL_USER_DATA_DIR`와 `DATA_DIR`를 별도 폴더로 지정하세요.

기존 **Tauri 2.0.0 → 2.1.0**은 한 번 직접 설치해야 합니다. 2.0.0을 트레이에서 완전히 종료하고 2.1.0 설치 파일을 실행하면 기존 게시글과 설정을 이어 읽습니다. 2.1.0부터 앱이 새 릴리즈를 자동으로 확인하며, 새 버전이 있으면 제목 옆의 업데이트 버튼으로 내려받아 설치할 수 있습니다.

정식 릴리즈를 빌드할 때는 `tauri.conf.json`의 [Tauri 업데이트 공개키](https://v2.tauri.app/plugin/updater/)에 대응하는 개인키의 내용 또는 경로를 `TAURI_SIGNING_PRIVATE_KEY`에 지정합니다. 암호가 있는 경우 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`도 지정합니다. GitHub 정식 릴리즈에는 설치 파일, 서명, 해당 파일의 URL과 서명을 담은 `latest.json`을 함께 게시합니다. 배포 작업은 빌드 명령이 수행하지 않습니다.

[Tauri UI 구조](docs/desktop-ui.md) · [이전 버전 릴리즈](https://github.com/kim-ximya/hotdealBackend/releases)
