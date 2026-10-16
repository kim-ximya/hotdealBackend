# 설정 UI 확장

설정 화면 전체를 하나의 패널로 사용하고, 본문만 스크롤합니다. 상단의 설정 종류와 실행 로그 버튼은 계속 표시됩니다.

- `settings-grid`: 창 너비에 따라 카드 열 수를 자동으로 조절합니다.
- `setting-card`: 기능별 제목·설명·입력·저장 상태를 묶는 기본 카드입니다.
- `setting-card-wide`: User-Agent처럼 넓은 입력 영역이 필요한 카드입니다.
- `setting-card-heading`, `setting-description`: 카드의 공통 제목과 안내 스타일입니다.

기존 카테고리에 기능을 추가할 때 해당 `settings-grid`에 카드를 추가합니다. 새 카테고리는 `.settings-tabs`에 고유 `id`, `role="tab"`, `aria-controls`를 가진 버튼을 추가하고 대응하는 `role="tabpanel"` 영역을 연결합니다. 탭 선택과 방향키 이동은 렌더러에서 자동 연결합니다.

실행 로그는 `LogWindow`가 관리하는 별도 비모달 창입니다. 서버 제어 API를 노출하지 않는 전용 preload와 IPC를 사용합니다. 로그 보관은 서버 컨트롤러가 맡으므로 로그 창을 닫아도 현재 세션의 기록은 남습니다. 같은 창을 중복 생성하지 않으며 앱 종료 시 창·IPC·이벤트 구독을 정리합니다.
