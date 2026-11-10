# Tauri 데스크톱 UI

메인, 실행 로그, 플로팅 알림은 각각 `main`, `logs`, `notification` WebView에서 열린다. UI 소스는 `desktop/`, 앱과 수집 백엔드는 `src-tauri/`에 있다.

- `desktop/tauri-bridge.js`가 Rust 명령과 이벤트를 기존 화면 동작에 연결한다. UI가 파일이나 프로세스를 직접 조작하지 않는다.
- `src-tauri/src/desktop.rs`가 트레이, 창 생명주기, 별도 로그 창, 명령 검증을 맡는다. 민감한 명령은 호출 창과 앱 내부 URL을 검사한다.
- `src-tauri/src/desktop/popup.rs`가 투명 알림 창, 묶음, 모니터 위치, 자동 닫기, 우측 드래그 애니메이션을 관리한다.
- `src-tauri/src/desktop/updates.rs`가 업데이트 확인과 서명 검증 후 설치를 분리한다. 설치 요청 전에는 자체 수집 작업을 종료한다.
- `src-tauri/src/core.rs`가 앱과 CLI가 공유하는 수집 서비스, 설정, 로그 및 게시글 상태를 관리한다.

설정 카드는 `settings-grid` 아래에 `setting-card`를 추가한다. 새 카테고리 탭의 `aria-controls`를 해당 패널 ID에 연결하면 렌더러가 탭 선택과 방향키 이동을 구성한다.

UI에 새 파일을 추가하면 `build/prepare-tauri.cjs`의 번들 파일 목록에도 등록한다. 메인, 로그, 알림 간 새 이벤트는 필요한 창으로만 보내고, 창별 명령의 접근 범위를 함께 검토한다.
