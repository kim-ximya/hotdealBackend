# Tauri 전환을 위한 1.1.0 기능 인벤토리

현재 Windows x64 설치판과 소스(`d7843d3`)를 기준으로 정리했다. 목표는 Electron 실행 환경을 제거하면서 화면 사용법, 수집 결과, 설정 및 외부 API 동작을 유지하는 것이다. 전환 전 기준선으로 `node --test test/*.test.js`를 실행해 88개 통과를 확인했다. 이 문서는 기능 목록과 전환 제안이며 구현 결과가 아니다.

```text
현재: HTML/CSS/JS → Electron preload/IPC → Electron 메인 → Node 수집 워커 → ChromeDriver → Chrome
제안: HTML/CSS/JS → Tauri 명령/이벤트 → Rust 수집 서비스 → ChromeDriver → Chrome
                                                └→ 기존과 호환되는 로컬 JSON API
```

## 프론트엔드

| 화면 | 현재 사용자 기능 | 전환 범위 |
| --- | --- | --- |
| 메인 상단 | 서버 시작·중지·외부 서버 연결 해제·지금 수집, 보관 건수, 최근 수집, 다음 수집 카운트다운, 브라우저 상태·오류 표시, 트레이로 숨기기 | [HTML·CSS와 상태 표시](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/renderer.js)는 재사용. 서버 상태 조회·구독과 버튼 호출을 Tauri 명령·이벤트로 연결 |
| 핫딜 목록 | 최신 ID 순으로 50개씩 표시. 제목·분류·작성자·작성 시각·조회·추천·댓글, New 태그, 페이지 이동, 원문 열기, 목록 새로고침 및 관심 품목만 보기. 조회나 새로고침은 크롤링을 요청하지 않음 | [목록 렌더러](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/article-list.js)는 재사용. 목록 응답과 갱신 조건, ID 기반 원문 열기를 유지 |
| 관심 품목 | 키워드 등록·삭제, 관심 품목의 새 글만 알림. 제목에 키워드 하나라도 포함되면 일치. 유니코드·대소문자·공백 정규화 후 비교하며, 필터는 페이지를 나누기 전에 적용 | [화면](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/interest-view.js)은 재사용. [검증·매칭 규칙](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/src/interests.js)과 [저장 형식](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/interest-settings.js)을 유지 |
| 설정 | 수집 간격(분·초), 저장 폴더 열기, 로컬 API 주소. 브라우저 User-Agent 저장 및 재시작 안내. 알림·소리 설정과 테스트. Windows 로그인 자동 실행 설정 및 상태 조회 | [카드와 탭](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/index.html)은 재사용. 파일·OS 작업을 Rust 명령으로 변경 |
| 실행 로그 | 설정에서 별도 창 열기. 최근 500개 세션 로그, 전체·오류·브라우저 필터, 자동 스크롤, 비우기. 창을 닫고 다시 열어도 같은 세션의 기록 유지 | [로그 렌더러](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/logs.js)는 재사용. [별도 창과 실시간 구독](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/log-window.cjs)은 다시 연결 |
| 플로팅 알림 | 오른쪽 아래에 최근 새 글 최대 3개와 나머지 건수. 알림음, 원문·목록 열기, 마우스 오버 시 유지, 기본 8초 후 닫기, 우측 드래그로 닫거나 복귀하는 애니메이션 | [HTML·CSS·음원](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/notification.html)과 [포인터 입력 처리](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/notification-drag.js)는 재사용 후보. [투명 창·위치·타이머·애니메이션 제어](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/floating-notifications.cjs)는 다시 구현 |
| 버전·업데이트 | 타이틀 아래 실행 버전 표시. 설치판은 시작 약 10초 후와 이후 6시간마다 확인. 새 버전이 있을 때만 버튼을 표시하고, 다운로드 진행률을 보여 준 뒤 별도 클릭으로 설치 | [업데이트 화면](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/update-view.js)은 재사용. 버전 조회·다운로드·검증·설치·재실행은 Tauri 쪽으로 교체 |

지금 화면은 `window.hotdeal`, `window.hotdealLogs`, `window.hotdealNotification`에 의존한다. 우선 이 인터페이스를 하나의 프론트엔드 어댑터에 모으면, 탭과 DOM 코드를 크게 바꾸지 않고 호출부만 Tauri `invoke`와 이벤트 구독으로 교체할 수 있다. 메인·로그·알림 창의 권한을 각각 제한하고, 민감한 명령은 Rust 쪽에서도 호출 창과 입력을 검증한다. [Tauri 명령과 이벤트](https://v2.tauri.app/develop/calling-rust/), [권한 검사](https://v2.tauri.app/security/runtime-authority/).

## 백엔드와 보존할 계약

| 영역 | 현재 구현과 동작 | 전환 시 보존할 기준 |
| --- | --- | --- |
| 브라우저 수집 | [수집기](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/src/selenium-collector.js)가 전용 프로필의 헤드리스 Chrome을 재사용한다. Selenium Manager로 드라이버를 준비하고, 핫딜 채널 첫 페이지에 접속해 일반 목록을 기다린 뒤 HTML을 읽는다. 보안 확인·접속 실패를 상태에 표시한다. | 같은 헤드리스 옵션·User-Agent·전용 프로필로 실사이트 동작을 먼저 검증. Tauri의 화면용 WebView2와 수집용 Chrome은 별개. Rust에서 ChromeDriver를 제어하더라도 드라이버 준비와 종료 관리는 필요 |
| 파싱 | [파서](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/src/article-parser.js)가 일반·하이브리드 목록에서 링크와 제목 등을 추출한다. 목록의 헤더와 특정 공지 행, 작성자명이 `*`로 시작하는 운영진 글을 제외하고, 남은 공지 행에는 `isNotice`를 기록한다. 로그인·보안 확인·목록 구조 이상을 정상 빈 목록으로 처리하지 않는다. | 저장된 HTML fixture로 결과 비교. ID는 문자열로 유지하고 숫자값 기준 정렬. 게시글 URL은 정해진 아카라이브 경로만 허용 |
| 수집 예약 | [수집 서비스](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/src/crawl-service.js)가 시작 시 즉시 한 번 수집한다. 기본 180초, 허용 1~86400초. 진행 중인 작업에 수동 요청을 합류시키고 놓친 예약을 한꺼번에 실행하지 않는다. | 시작·중지·즉시 수집·간격 변경, 중복 방지와 종료 중 취소를 기존 테스트와 동일하게 검증 |
| 파일 저장 | [저장소](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/src/article-store.js)가 게시글을 ID로 병합하고 최신 순으로 기본 10,000개를 보관한다. 임시 파일 작성 후 교체하며, 실패 시 마지막 성공 데이터를 유지한다. | `articles.json` 구조와 기존 파일 읽기, `firstSeenAt`·`lastSeenAt`, 정상 저장 후에만 새 스냅샷과 이벤트 공개, 손상 파일 보존 |
| New와 알림 | **New 태그**는 새로 추가되어 실제로 보관된 최신 묶음에 붙으며 새 글 없는 수집에서는 유지된다. **플로팅 알림**은 [별도 추적기](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/new-article-tracker.js)가 최초 빈 저장소의 첫 수집을 기준으로 삼은 뒤, 이전 최대 ID보다 큰 새 글을 알린다. | 두 규칙을 합치지 않는다. 첫 수집에 New가 보이면서 알림은 나오지 않을 수 있다. 실패·재등장·기존 글 수정은 알림 대상이 아니며 관심 품목 필터는 알림 표시 전에 적용 |
| 소유 서버·외부 서버 | [컨트롤러](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/server-controller.js)는 앱이 직접 띄운 [워커](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/server-worker.js)와 별도로 실행된 호환 서버를 구분한다. 중지 상태의 목록은 로컬 JSON, 실행 상태의 목록은 API에서 읽는다. 외부 서버의 새 글은 폴링으로 감지한다. | 앱 종료·업데이트는 자체 수집 작업을 정리하고, 외부 서버는 연결만 끊는다. 자체 서버의 목록을 Rust 상태에서 직접 읽도록 바꾸더라도 결과 계약을 유지. [터미널 서버](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/main.js)는 독립 실행 기능을 유지한다면 같은 Rust 코어를 공유하는 CLI로 교체 |
| 로컬 HTTP API | [API](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/src/crawler-api.js)는 기본 `127.0.0.1:38471`에만 바인딩한다. `GET /api/articles?limit&offset`, `GET /api/status`, `GET/PUT /api/settings`, `POST /api/collect`. 마지막은 완료를 기다리지 않고 요청 수락(202)을 반환한다. | 앱 내부 IPC로 대체하지 않고 외부 웹·앱과의 호환 인터페이스로 유지. 응답 필드·상태 코드, 정확한 Host·Origin 검사, CORS 허용 목록, JSON 입력 검증과 크기 제한을 테스트 |

현재 수집은 폴링이다. 수집 간 첫 페이지 밖으로 밀린 게시글을 복구하거나, 실시간 수신하는 기능은 전환 범위에 포함하지 않는다. [WebDriver 표준](https://www.w3.org/TR/webdriver/), [Selenium Manager](https://www.selenium.dev/documentation/selenium_manager/).

## Windows 통합 및 배포

| 영역 | 현재 구현 | Tauri에서 확인할 점 |
| --- | --- | --- |
| 트레이·앱 생명주기 | [Electron 메인](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/main.cjs)이 닫기·최소화를 트레이 숨기기로 바꾸고, 중복 실행 시 기존 창을 복원한다. 완전 종료는 작업과 브라우저 정리 후 진행한다. | Tauri 트레이와 단일 인스턴스 플러그인. 숨김과 완전 종료를 구분하고, 종료 실패 시 창과 오류를 다시 표시. 이전 Electron 앱과 Tauri 앱을 함께 실행하면 각자의 단일 인스턴스 잠금만으로는 같은 데이터에 쓰는 것을 막을 수 없으므로 전환 테스트는 구버전을 완전히 종료하거나 복제 데이터로 수행 |
| 로그인 자동 실행 | [Windows 시작 설정](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/windows-startup.cjs)은 현재 사용자 등록과 Windows에서 사용 중지한 상태를 구분한다. 전용 인수로 시작하면 트레이에서 수집 서버도 시작한다. | Tauri Autostart 또는 필요한 Windows 등록 처리로 대체. 기존 실행 경로가 남아 중복 시작하지 않게 하고, Windows에서 비활성화한 선택을 보존 |
| 알림 창 | 투명·프레임 없음·항상 위·작업 표시줄 제외. 메인 창이 있는 모니터의 작업 영역에 표시하고 포커스를 빼앗지 않는다. | WebView2 실제 창에서 비활성 표시, 드래그 및 클릭, 화면 배율·다중 모니터·작업 표시줄을 검증. DOM 애니메이션만으로 해결되는 부분과 네이티브 창 이동을 분리 |
| 저장 경로 | [경로 설정](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/runtime-paths.cjs)은 설치판에서 `%APPDATA%\HotdealCollector`를 사용한다. `collector` 아래에 `articles.json`, `settings.json`, `browser-settings.json`, Chrome 프로필과 드라이버 캐시가 있으며, 루트에는 `notification-settings.json`과 `interest-settings.json`이 있다. | Tauri 기본 경로를 그대로 쓰면 다른 폴더를 읽을 수 있으므로 기존 경로 사용 또는 명시적 가져오기를 설계. `HOTDEAL_USER_DATA_DIR`·`DATA_DIR` 재정의 고려. 설정·게시글은 원본을 보존하고 검증, 프로필·캐시는 데이터 형식과 별개로 재사용 가능 여부 확인 |
| 설치·자동 업데이트 | [패키징 설정](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/package.json)은 Electron Builder NSIS로 빌드하고 공개 GitHub에 설치 파일·`latest.yml`·blockmap을 배포한다. [업데이트 관리자](https://github.com/kim-ximya/hotdealBackend/blob/d7843d373f90065243b79771c0d3a85b3d5beacf/desktop/app-updates.cjs)는 서버 종료 실패 시 설치를 중단한다. | Tauri NSIS 설치판과 서명된 Tauri 업데이트 파일, 공개키, 별도 업데이트 메타데이터(예: `latest.json`)가 필요. Windows 설치 호출 전에 자체 수집 정리를 완료. 기존 Electron이 새 피드를 직접 이해하지 않으므로 첫 Tauri판은 **수동 전환**을 기본안으로 하고, 인앱 전환은 구버전 설치 제거·데이터 유지까지 검증한 별도 릴리즈가 있을 때만 채택 |

설치판의 UI 렌더링은 WebView2가 담당한다. Chrome은 수집에 계속 필요하다. 개발에는 Rust와 Windows C++ 빌드 도구를 준비해야 한다. [Windows 전제 조건](https://v2.tauri.app/start/prerequisites/), [트레이](https://v2.tauri.app/learn/system-tray/), [Autostart](https://v2.tauri.app/plugin/autostart/), [Windows 설치판](https://v2.tauri.app/distribute/windows-installer/), [Tauri 업데이트 서명](https://v2.tauri.app/plugin/updater/).

## 권장 작업 순서

1. **동작 기준 고정:** 현재 HTML fixture·JSON 예시·HTTP 응답·자동 테스트를 비교 기준으로 남긴다. 데이터 경로와 기존 릴리즈에서 넘어오는 절차를 먼저 결정한다.
2. **수집 검증과 UI 연결:** Tauri에서 메인 화면과 명령 어댑터를 띄우고, 별도 테스트 프로필에서 Rust → ChromeDriver → Chrome으로 핫딜 첫 페이지를 가져오는 작은 검증을 먼저 한다. 브라우저 접속 조건을 전환 후에도 만족하는지는 실제로 확인해야 한다.
3. **수집 코어 이식:** 파서, 저장, 수집 예약, 설정, 상태, 외부 API를 순차 이식한다. 같은 입력에서 기존과 같은 결과가 나오는지 확인한 뒤 메인 화면·로그·알림을 새 이벤트에 연결한다.
4. **Windows 설치 검증:** 트레이·자동 시작·다중 모니터 알림·설치 및 삭제·구버전 데이터 유지·서명 업데이트를 실제 설치판으로 검증한다. UI와 수집 기능이 모두 대체된 뒤 Electron 런타임, preload, 워커, 빌더를 정리한다.

완전 전환을 **설치판에서 Node 런타임도 제거**하는 것으로 잡으면 수집 백엔드의 Rust 이식을 권장한다. 기존 Node 수집기를 Tauri의 [사이드카](https://v2.tauri.app/develop/sidecar/)로 묶으면 Electron을 먼저 제거할 수 있지만, Node 기반 수집과 별도 실행 파일 관리가 남는다. 빌드용 프론트엔드 도구와 수집에 필요한 Chrome·ChromeDriver는 앱에 포함되는 Electron·Node 런타임과 별개다.
