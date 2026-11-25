# 브라우저 자동화

자연어로 요청한 문서 찾기·검색·페이지 탐색을 브라우저에서 실행합니다. Decision Model이 고른 다음 행동을 적용하거나, 분기 기준을 만족할 때 Claude Code에서 같은 후보를 다시 판단합니다. 앱에는 단계별 판단 모델과 호출 횟수, 마지막 도착 페이지가 표시됩니다.

연구 질문은 정답 페이지 도달률을 얼마나 유지하면서 LLM 호출과 실행 시간을 줄일 수 있는가입니다. 브라우저 조작과 모의 사이트는 상위 engram 프로젝트의 조작 틀과 연구용 사이트를 기반으로 구현했습니다.

## 실행

Node 22.17 이상과 Chromium이 필요합니다.

```sh
npm install
npx playwright install chromium
npm test
npm run typecheck
cp .env.example .env
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. Claude Code에 로그인한 로컬 계정을 쓰려면 `LLM_PROVIDER=cli`로 지정합니다. `LLM_MODEL`을 비워두면 `sonnet`을 사용합니다. API 키 없이도 로컬 CLI 경로를 사용할 수 있습니다. Anthropic API로 실행할 때는 API 키를 지정하고 CLI 강제 설정을 비웁니다.

`DECISION_BASE_URL`은 Decision 엔드포인트 전체 주소이며, `DECISION_MODEL`과 필요한 인증 키를 `.env`에 넣습니다. 소형 모델 미연결 상태에서는 LLM이 단독으로 판단합니다. 최종 실험 결과를 반영해 `APP_POLICY=fixed`와 검증에서 고른 확률 격차 0.545를 기본 구성으로 두었습니다. 학습된 위험 정책을 쓰려면 `APP_POLICY=risk`를 지정합니다. 이때 `data/calibration.json`의 기준을 사용하며 `RISK_THRESHOLD`로 변경할 수 있습니다.

## 발표 시연

- `npm run demo`로 모의 모델과 회의록 예시를 엽니다. 예시 버튼을 누르고 실행하면 완료 판단과 도착 페이지 채점이 어긋나는 경우를 재현합니다.
- `npm run demo:real`은 같은 예시를 설정된 모델로 실행하고 도착 페이지를 채점합니다.
- `PORT=3010`으로 포트를 바꾸거나 `HEADLESS=1`로 제어용 브라우저 창을 숨길 수 있습니다.

## 실험 재현

학습용 8개, 검증용 8개, 평가용 14개 과제를 사이트 ID 기준으로 분리합니다. 아래 명령은 각각 새 `runs/` 디렉터리에 매니페스트와 실행별 JSONL을 저장합니다.

```sh
npm run experiment -- --condition=small --set=train --repeat=5 --parallel=4
npm run experiment -- --condition=small --set=validation --repeat=5 --parallel=4
npm run train -- "$train_dir" "--validation=$validation_dir"
```

`train_dir`과 `validation_dir`에 앞선 실행에서 출력된 디렉터리를 지정합니다. 학습은 소형 단독의 유효 실행만 사용합니다. 검증에서 고정 기준과 학습된 위험이 각각 약 35%의 판단을 LLM으로 보낼 수 있도록 기준을 조정합니다. 최종 실험에서는 아래 기준을 고정했습니다.

```sh
npm run experiment -- --condition=small --set=eval --repeat=2 --parallel=4
npm run experiment -- --condition=always --set=eval --repeat=2 --parallel=4
npm run experiment -- --condition=fixed --threshold=0.545 --set=eval --repeat=2 --parallel=4
npm run experiment -- --condition=risk --threshold=0.47696441967861886 --set=eval --repeat=2 --parallel=4
npm run experiment -- --condition=llm --set=eval --repeat=2 --parallel=4
```

두 모델 상시 호출은 소형 모델을 먼저 호출하고 매 단계 LLM의 결정을 실행합니다. LLM 단독은 소형 모델을 부르지 않습니다. 성공 여부는 도착 경로와 사이트 측 상태로 판단합니다. 비용은 Claude Code가 반환한 정가 환산액입니다. Decision Model 단가가 있으면 `SMALL_PRICE_CALL`을 호출당 USD로 지정해 JSON 집계에 포함할 수 있습니다.

```sh
npm run report -- "$small_dir" "$always_dir" "$fixed_dir" "$risk_dir" "$llm_dir"
npm run report -- --json "$small_dir" "$always_dir" "$fixed_dir" "$risk_dir" "$llm_dir"
```

최종 모의 실험의 집계는 [experiment-results.json](deliverables/experiment-results.json)에 있습니다. 원시 로그는 실험을 실행할 때 로컬 `runs/` 아래 생성되며, 가중치와 검증 기준은 `data/`에 있습니다.

## 공개 문서 탐색 실험

`npm run experiment:public`은 기본 정책으로 MDN, Python, Playwright의 공개 문서 찾기를 각 1회 실행합니다. 정해진 도착 경로를 확인하고 `deliverables/public-site-pilot.json`에 행동 기록을, `runs/public-site-pilot/`에 도착 화면을 저장합니다. 집계된 LLM 호출은 행동 판단에 사용한 호출입니다.

`npm run experiment:public -- --everyday --retry`로 쇼핑몰·서점·공공 관람 안내 과제를 실행할 수 있습니다. 처음 실행과 검색 동작 보완 후 재실행은 `deliverables/everyday-site-pilot.json`과 `deliverables/everyday-site-retry.json`에 각각 기록했습니다.

## 구조

- `src/`은 Playwright 상태 수집, 행동 선택, 위험 정책, 모델 연결, 로컬 API를 구현합니다.
- `public/index.html`은 요청 입력과 단계별 실행 화면입니다.
- `experiment/`에는 모의 사이트, 실험 실행기, 위험 모델 학습기와 집계기가 있습니다.
- `test/`는 브라우저·API·정책 회귀 검사와 발표용 시연의 진입점입니다.
