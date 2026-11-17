# 发布步骤：GitHub + Greasy Fork

## 一、GitHub

### 1. 创建公开仓库
1. 登录 GitHub。
2. 点击右上角 `+` → `New repository`。
3. Repository name 填：`bili-downloader`（仓库名不能包含空格）。
4. Description 可填写：`Bilibili 分P智能下载管理器用户脚本，支持本地文件扫描、单文件与批量下载。`
5. 选择 `Public`。
6. 建议先不要勾选自动生成 README、License 或 `.gitignore`，避免与本地准备文件冲突。
7. 创建仓库。

### 2. 上传文件
上传以下文件：
- `bili-downloader.user.js`：经测试的完整用户脚本；
- `README.md`；
- `CHANGELOG.md`；
- `TESTING.md`；
- `PUBLISHING.md`；
- `LICENSE`：作者确认许可证后再加入。

可在仓库页面使用 `Add file` → `Upload files`，也可使用 Git。

### 3. 创建 Release
1. 在仓库页面进入 `Releases` → `Create a new release`。
2. Tag 填 `v5.0.0`。
3. Release title 填 `Bili Downloader v5.0.0`。
4. 描述本版本新增功能、已知限制和测试环境。
5. 附加 `.user.js` 文件。
6. 只有通过测试后才标记为正式稳定版本；否则标题注明 Pre-release。

## 二、Greasy Fork

### 1. 提交前检查
- 必须提交完整、可审查、未混淆的脚本源代码。
- 脚本主要功能必须包含在 Greasy Fork 页面所托管的代码中；不要只放一个从 GitHub 远程加载主体代码的 loader。
- 填写清晰的功能说明和适用网站。
- 不得包含未披露的追踪、广告、挖矿或隐私收集行为。
- 确认脚本版权和许可证。若基于他人代码，先确认上游许可证允许再发布。

### 2. 发布
1. 注册并登录 Greasy Fork。
2. 打开个人主页，选择 `发布您编写的脚本`（Publish a script you've written）。
3. 将完整 `.user.js` 源码粘贴到代码编辑区。
4. 填写中文名称、简介、适用网站、版本及许可证。
5. 预览脚本信息和代码，再提交。
6. 通过审核并获得脚本页面后，把 Greasy Fork 页面链接补充到 GitHub README。

### 3. 更新
- 先在 GitHub 测试并提交新版本。
- 更新 userscript 头部的 `@version`。
- 再将完整新代码提交到 Greasy Fork。
- 保持 `@name` 与 `@namespace` 稳定，避免被脚本管理器识别成另一个脚本。
- 不要在脚本中自行高频检查更新；通常由用户脚本管理器处理更新。

## 三、双平台版本同步建议
- GitHub 是源码、问题跟踪和版本说明的主仓库。
- Greasy Fork 托管可直接安装的完整脚本。
- 两边的版本号、功能说明和已知限制保持一致。
- 每次发布都更新 CHANGELOG，并记录实际测试环境。

## 四、正式发布前必须完成
1. 将最终修复合并进完整 `.user.js` 文件。
2. 完成 `TESTING.md` 中的测试。
3. 确认 `.mp4` / `.m4a` 扩展名与实际编码相符。
4. 确认下载失败/停止时不会留下被误认为完整的文件。
5. 作者确认许可证及版权声明。
