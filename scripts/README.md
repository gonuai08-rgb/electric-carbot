# 법령 데이터 미리 받기 (GitHub Actions → JSON)

전기차 민원에 쓰는 근거 법령은 **정해진 목록**이라 실시간 검색이 필요 없다.
GitHub 서버(Actions)가 주기적으로 [국가법령정보센터 Open API(law.go.kr / DRF)](https://open.law.go.kr)에서
현행 조문을 받아 `public/data/laws.json` 으로 저장하고, 웹페이지는 **같은 도메인의 이 파일만** 읽는다.
→ 페이지는 여전히 "실행 중 외부 API 호출 0회". 파일이 없으면 `index.html`의 수기 요약이 대신 표시된다.

## 구성

| 파일 | 역할 |
|---|---|
| `scripts/laws.config.json` | 받을 법령 목록. `articles`가 비면 전체 조문. 조문 키 `58` = 제58조, `79-4` = 제79조의4. 별표 키 `21-2` = 별표 21의2. |
| `scripts/fetch-laws.mjs` | Node 20+ 내장 `fetch`만 사용(외부 의존성 없음). `public/data/laws.json` 과 `data/laws.json` 두 곳에 저장. |
| `.github/workflows/fetch-laws.yml` | 매주 월 09:15(KST) + 수동 실행 + 스크립트 변경 시. 변경분만 커밋. |
| `public/data/laws.json` | 배포되는 결과물(Firebase Hosting이 서빙). |

## 로컬에서 직접 갱신

```powershell
node scripts/fetch-laws.mjs
```

## OC 키

`OC` 파라미터가 필요하다. 우선순위: 환경변수 `LAW_OC` > `laws.config.json`의 `"oc"` > `"test"`.
- 지금은 공용 키 `test` 로 동작한다(저사용량 한정, 별도 등록 불필요).
- 안정적으로 쓰려면 <https://open.law.go.kr> 에서 이메일로 **무료 발급** 후
  GitHub 저장소 → Settings → Secrets and variables → Actions → `LAW_OC` 로 등록.

## GitHub 준비 (이 폴더는 아직 git 저장소가 아님)

1. `git init` 후 GitHub에 새 저장소 생성·푸시
2. 저장소 Settings → Actions → General → **Workflow permissions**를 *Read and write*로
3. (선택) 위의 `LAW_OC` Secret 등록
4. Actions 탭에서 **법령 데이터 갱신** 워크플로를 한 번 수동 실행(Run workflow)

## 지금 받는 법령

- 대기환경보전법 제58조·제58조의2
- 대기환경보전법 시행규칙 제79조의4 + 별표 21의2(사용기간별 지원금액 회수기준)
- 환경친화적 자동차법 제2조·제10조·제10조의2
- 환경친화적 자동차법 시행령 제18조·제18조의2·제19조
- 부산광역시 환경친화적 자동차 보급 촉진 및 이용 활성화에 관한 조례(전체 조문)
