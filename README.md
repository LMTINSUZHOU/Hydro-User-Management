# Hydro 用户管理插件

适用于 Hydro 5.0+ 的用户管理插件。插件参考
[`hydrooj-resetPwd`](https://github.com/15921483570/hydrooj-resetPwd/) 的插件入口方式实现，
在控制面板中提供可视化用户查询、导出、批量添加、批量删除和批量修改能力，同时保留脚本入口，
方便管理员在不同场景下使用。

## 功能特性

- 按 UID、用户名、电子邮件查询用户，也支持自动识别查询关键词。
- 导出当前查询结果；不输入查询条件时可导出全部真实用户。
- 在查询结果最后一列提供“修改”和“删除”按钮。
- 点击“修改”后弹出表单，可修改用户名、电子邮件、显示名、学校、学号、角色、Groups、权限。
- 点击“删除”后弹出确认框，确认后清理关联数据并禁用用户。
- 支持批量添加用户。
- 支持批量修改用户信息，包括用户名、邮箱、密码、权限、显示名、学校、学号、头像、性别、简介、域角色、加入状态和用户组。
- 支持批量禁用用户、清理用户关联数据，也可选择物理删除用户文档。
- 支持预览模式，批量操作默认先预览，降低误操作风险。
- 控制面板操作需要 `PRIV_EDIT_SYSTEM` 权限，并受 Hydro sudo 验证保护。

## 安装方式

将本项目放到 Hydro 可读取的 addon 目录后，以本地插件方式安装：

```bash
yarn global add file:/root/.hydro/addons/hydro-plugin-user-management
hydrooj addon add hydro-plugin-user-management
pm2 restart hydrooj
```

安装完成后，进入 Hydro 控制面板，打开“批量用户管理”页面即可使用。

## 页面入口

控制面板入口：

```text
Control Panel -> 批量用户管理
```

插件也会注册三个脚本入口，可在 Hydro 脚本管理中调用：

- `batchAddUser`：批量添加用户。
- `batchUpdateUser`：批量修改用户。
- `batchDeleteUser`：批量禁用或删除用户。

## 查询用户

查询区域支持以下字段：

- `auto`：自动判断 UID、用户名或邮箱。
- `uid`：按用户 UID 查询。
- `uname`：按用户名查询。
- `mail`：按电子邮件查询。

输入关键词后点击“查询”。查询结果会显示：

- UID
- 用户名
- 电子邮件
- 显示名
- 学校
- 学号
- 角色
- Groups
- 权限
- 操作按钮

## 修改用户

在查询结果的最后一列点击“修改”，页面会弹出修改表单。支持修改字段：

- 用户名
- 电子邮件
- 显示名
- 学校
- 学号
- 角色
- Groups
- 权限

填写完成后点击“保存”。保存成功后会回到当前查询结果。

Groups 支持使用英文逗号 `,` 或分号 `;` 分隔，例如：

```text
class-a,class-b
```

## 删除用户

在查询结果的最后一列点击“删除”，页面会弹出确认框。确认后插件会执行安全删除逻辑：

- 清理用户关联数据。
- 禁用用户。
- 默认不物理删除用户文档。

批量删除时如果确实需要物理删除用户文档，可勾选“物理删除用户文档”。该操作风险较高，建议先使用预览模式确认结果。

## 导出用户

点击“导出 CSV”可导出当前查询结果。

如果查询条件为空，导出结果会包含全部真实用户（UID >= 1）。

CSV 字段包括：

- `uid`
- `uname`
- `mail`
- `displayName`
- `school`
- `studentId`
- `role`
- `join`
- `priv`
- 注册时间
- 登录时间
- Groups
- 头像
- 性别
- 简介

## 批量数据格式

批量操作支持 CSV、TSV、JSON 数组，以及逐行 JSON 对象。

CSV 和 TSV 的第一行可以是表头。推荐使用表头，字段顺序更清晰，也更适合后续维护。

### 批量添加

默认字段示例：

```text
mail,uname,password,displayName,school,studentId,uid,group
alice@example.com,alice,abcdef,Alice,No.1 Middle School,20260001,,class-a
bob@example.com,bob,abcdef,Bob,No.1 Middle School,20260002,,class-a
```

常用字段：

- `mail`：邮箱。
- `uname`：用户名。
- `password`：初始密码。
- `displayName`：显示名。
- `school`：学校。
- `studentId`：学号。
- `uid`：指定 UID，可留空由系统生成。
- `group` 或 `groups`：用户组。

### 批量修改

批量修改建议使用 UID 定位用户：

```text
uid,displayName,password,school,role,join
1002,Alice Zhang,newpass123,No.2 Middle School,default,true
```

也可以修改 Groups：

```text
uid,groups
1002,class-a;contest-team
```

### 批量删除

批量删除只需要提供 UID：

```text
uid
1003
1004
```

默认行为是清理关联数据并禁用用户，不会物理删除用户文档。

### JSON 格式

也可以使用 JSON 数组：

```json
[
  {"mail": "alice@example.com", "uname": "alice", "password": "abcdef"},
  {"uid": 1002, "displayName": "Alice Zhang", "school": "No.2 Middle School"}
]
```

或逐行 JSON 对象：

```json
{"mail": "alice@example.com", "uname": "alice", "password": "abcdef"}
{"uid": 1002, "displayName": "Alice Zhang", "school": "No.2 Middle School"}
```

## 安全说明

- Web 页面入口要求管理员具备 `PRIV_EDIT_SYSTEM` 权限。
- 修改和删除单个用户时需要通过 Hydro sudo 验证。
- 插件禁止修改超级管理员和系统保护用户。
- 批量操作默认支持预览模式，建议先预览再执行正式操作。
- 物理删除用户文档不可逆，使用前请确认已经备份数据库。

## 开发与验证

本项目主要文件：

- `index.ts`：插件入口、用户处理逻辑、路由和脚本注册。
- `templates/manage_user_management.html`：控制面板页面模板。
- `package.json`：插件包信息和发布文件白名单。
- `tsconfig.json`：TypeScript 配置。

可执行以下检查：

```bash
npm pack --dry-run
```

打包白名单只包含插件运行需要的源码、模板和文档文件。

## 开源许可证

本项目使用 MIT License，许可证内容见 `LICENSE`。
