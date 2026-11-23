# mock-weaver — 泛微 OA 模拟器

为 FastGPT 泛微同步 + 泛微 SSO 提供可自造数据的假泛微 OA。零依赖（Node >= 16），数据落盘 `data/orgs.json`。

## 快速开始

```bash
npm start              # 或 node server.js，默认 0.0.0.0:9100
# 打开 http://localhost:9100/  → 管理页（CSV 导入 / 手动编辑）
```

Docker:

```bash
docker build -t mock-weaver . && docker run -p 9100:9100 -v $PWD/data:/app/data mock-weaver
```

## 对接配置

### 同步（sso 服务 weaver provider）

```yaml
WEAVER_BASE_URL: "http://<mock-host>:9100"
WEAVER_HR_AUTH_MODE: "ip"      # token 模式亦可：mock 会正常响应 applytoken
WEAVER_ACTIVE_STATUSES: "0,1,2,3"
```

### 泛微 SSO（sso 服务 oauth2 provider）

```yaml
OAUTH2_AUTHORIZE_URL: "http://<mock-host>:9100/sso/oauth2.0/authorize"
OAUTH2_TOKEN_URL: "http://<mock-host>:9100/sso/oauth2.0/accessToken"
OAUTH2_USER_INFO_URL: "http://<mock-host>:9100/sso/oauth2.0/profile"
OAUTH2_CLIENT_ID: "mock"
OAUTH2_CLIENT_SECRET: "mock"
OAUTH2_USERNAME_MAP: "attributes.workcode"
OAUTH2_MEMBER_NAME_MAP: "attributes.lastname"
OAUTH2_CONTACT_MAP: "attributes.mobile"
OAUTH2_SOURCE_ID: "weaver"     # 与同步侧来源一致
```

## 接口清单

| 用途 | 接口 |
| --- | --- |
| HR token | `POST /api/ec/dev/auth/applytoken`（headers: `appid` / `secret`）→ `{token, expires_in}` |
| 分部分页 | `POST /api/hrm/resful/getHrmsubcompanyWithPage`（body `{params:{pagesize,curpage}}`） |
| 部门分页 | `POST /api/hrm/resful/getHrmdepartmentWithPage` |
| 人员分页 | `POST /api/hrm/resful/getHrmUserInfoWithPage`（支持 `departmentid` 逗号多值 / `subcompanyid1` 单值 / `workcode` 过滤，与真实接口一致） |
| OAuth2 登录页 | `GET /sso/oauth2.0/authorize?client_id&redirect_uri&response_type=code&state` |
| OAuth2 token | `POST /sso/oauth2.0/accessToken`（form: grant_type/client_id/code/redirect_uri/client_secret） |
| OAuth2 用户信息 | `GET /sso/oauth2.0/profile`（`Authorization: Bearer …`）→ 含 `attributes.{workcode,lastname,mobile,…}` |
| 管理数据 | `GET /api/data` · `POST /api/import` · CRUD `/api/users|departments|subcompanies` · `POST /api/reset` |
| 健康检查 | `GET /healthz` |

## 管理页功能

- **CSV 导入**：人员/部门/分部三张表各自支持上传 CSV（替换全部 或 追加/更新），提供模板下载与导出
- **手动编辑**：页面直接增删改每一条记录
- **人员状态**：`status` 模拟在职/离职（4/5 会被同步过滤）；`accounttype=1` 模拟次账号（默认不同步）
- **任意工号登录**：OAuth2 登录页支持以名单外工号模拟登录（不落库，用于测试"未命中 → 建号/认领"链路）

## CSV 格式

人员（workcode 必填，按 workcode 去重）：

```csv
workcode,lastname,status,accounttype,departmentid,subcompanyid1,mobile,email,telephone
77000136,张三,0,0,11,1,13800000136,zhangsan@example.com,
```

部门（id 为泛微原始 id；supdepid=0 顶层，挂在 subcompanyid1 下）：

```csv
id,departmentname,supdepid,subcompanyid1,canceled
11,研发部,0,1,0
```

分部（supsubcomid=0 顶层）：

```csv
id,subcompanyname,supsubcomid,canceled
1,泛微网络,0,0
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `9100` | 监听端口 |
| `DATA_FILE` | `./data/orgs.json` | 数据文件路径 |
| `MOCK_EXPECT_APP_ID` / `MOCK_EXPECT_SECRET` | 空 | applytoken 校验（空 = 不校验） |
| `MOCK_STRICT_TOKEN` | `0` | `1` = HR 业务接口强制有效 token |
| `MOCK_SSO_ACTIVE_STATUSES` | `0,1,2,3` | SSO 登录页展示的状态范围 |
| `MOCK_AUTHORIZE_PATH` / `MOCK_TOKEN_PATH` / `MOCK_PROFILE_PATH` | `/sso/oauth2.0/*` | OAuth2 三段路径 |

## 验证链路（手测脚本）

```bash
# 1. 同步：token 模式
curl -s -X POST http://localhost:9100/api/ec/dev/auth/applytoken -H 'appid: mock' -H 'secret: dummy' | jq
curl -s -X POST http://localhost:9100/api/hrm/resful/getHrmUserInfoWithPage \
  -H 'Content-Type: application/json' -d '{"params":{"pagesize":100,"curpage":1}}' | jq
# 2. SSO：浏览器打开
#   http://localhost:9100/sso/oauth2.0/authorize?client_id=mock&redirect_uri=http://localhost/callback&response_type=code&state=x
#   点选用户 → 跳回带 code →
curl -s -X POST http://localhost:9100/sso/oauth2.0/accessToken \
  -d 'grant_type=authorization_code&client_id=mock&code=<code>&redirect_uri=http://localhost/callback&client_secret=mock'
curl -s http://localhost:9100/sso/oauth2.0/profile -H 'Authorization: Bearer <access_token>'
```
