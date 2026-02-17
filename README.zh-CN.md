# 自研 JS 反混淆辅助工具

在逆向多个平台签名 JS（mnsv2 / webmssdk / um.js 等）的过程中，频繁遇到 obfuscator 级别的代码混淆，手工还原效率极低。因此自研了这套 Node.js 命令行工具，针对实际逆向中最常见的混淆模式进行自动化还原。

## 实际效果

处理前（混淆代码）:
```js
var _0x3f2a = 0x1a2b;
window["\x63\x6f\x6e\x73\x6f\x6c\x65"]["\x6c\x6f\x67"](!0);
_0xa1 = 1, _0xa2 = 2, _0xa3 = _0xa1 + _0xa2;
if (false) { console.log("dead"); }
```

处理后（还原代码）:
```js
var _0x3f2a = 6699;
window.console.log(true);
_0xa1 = 1;
_0xa2 = 2;
_0xa3 = _0xa1 + _0xa2;
```

## 17 个插件 & 执行顺序

```
strarr → string → strconcat → hex → obj → prop → iife → callapply → constant → builtin → control → comma → strconcat → anti → dead → member → rename
```

| 插件 | 功能 | 核心技术 |
|------|------|----------|
| strarr | 字符串数组动态解密 | vm 沙箱执行 |
| string | 转义还原/fromCharCode | 字面量解析 |
| strconcat | 字符串拼接还原 | `s="se"; s+="tItem"` → `s="setItem"` |
| hex | 十六进制数字还原 | extra.raw 清除 |
| obj | 对象字典/包装器内联 | 属性替换+函数体内联 |
| prop | 常量传播 | 引用替换+声明清理 |
| iife | IIFE/包装器内联 | 参数替换+安全检查 |
| callapply | call/apply/间接调用内联 | `fn.call(null,a)` → `fn(a)` |
| constant | 常量折叠 | 编译期求值 |
| builtin | 安全内置静态求值 | Math/parseInt/atob 白名单 |
| control | 控制流平坦化还原 | 序列驱动+状态机+条件分支 |
| comma | 逗号表达式拆分 | 语句展开 |
| anti | 反调试清理 | debugger/setInterval/Function |
| dead | 死代码删除 | if(false)/while(false)/未用函数 |
| member | 属性简化 | 计算属性→点号 |
| rename | 混淆变量重命名 | 多模式识别+scope.generateUid |

> 顺序有依赖：先解密/还原字符串与数字 → 对象字典/包装器内联让表达式变简单 → 常量折叠/内置静态求值继续把“花指令”压平 → 再做控制流/清理

## 使用方式

```bash
# 安装依赖
npm install

# 反混淆工具 — 17 个插件
node src/index.js -i test/sample_obfuscated.js -o output.js

# 只用部分插件
node src/index.js -i input.js -o output.js --plugins string,hex,constant,member

# 运行单元测试
npm test

# 目录批处理：递归处理目录下所有 .js/.mjs/.cjs 并镜像输出目录结构
node src/index.js -i ./input_dir -o ./output_dir

# 目录批处理：自定义后缀与忽略规则
node src/index.js -i ./input_dir -o ./output_dir --ext .js,.mjs --ignore node_modules,dist,build

# 预设场景：source(源码工程) / bundle(打包产物) / reverse(逆向脚本集合)
node src/index.js -i ./input_dir -o ./output_dir --scene source
node src/index.js -i ./dist -o ./dist_deob --scene bundle
node src/index.js -i ./dump_js -o ./dump_js_deob --scene reverse

# 多轮迭代：一些混淆需要“解一层 → 再触发下一层”，可以提高 passes
node src/index.js -i ./dump_js -o ./dump_js_deob --scene reverse --passes 3

# bundle 拆包：识别 webpack bootstrap/webpackChunk push 并导出模块（不影响 deob 输出）
node src/index.js -i ./dist/app.js -o ./dist_deob/app.deob.js --scene bundle --webpack-extract

# 指定 webpack 模块导出目录
node src/index.js -i ./dist -o ./dist_deob --scene bundle --webpack-extract --webpack-modules-out ./dist_modules

# 目录模式聚合导出：把多个 chunk/多个文件识别到的模块合并到同一目录（同一份 modules.json）
node src/index.js -i ./dist -o ./dist_deob --scene bundle --webpack-extract --webpack-aggregate

# VM 混淆分析：检测 switch-dispatch / handler-table VM 并输出 opcode 分类报告
node src/index.js -i ./vm_code.js -o ./vm_code.deob.js --vm-analyze
```

> 大文件/工程代码说明：解析使用 `sourceType: unambiguous` + `errorRecovery`，对 CommonJS/ESM 混用更友好；但如果输入目录包含打包产物（dist/build）或 `node_modules`，建议通过 `--ignore` 排除，否则会显著拖慢处理速度。

### 三类场景建议 (A/B/C)

| 场景 | `--scene` | 目标 | 默认策略 |
|------|-----------|------|----------|
| 源码工程 (A) | `source` | 可读性优先、尽量不破坏语义 | 默认启用全部插件；默认忽略 `node_modules/dist/build/out/.git/coverage` |
| 打包产物 (B) | `bundle` | 速度优先、只做“低风险还原” | 默认关闭 `strarr/control/rename`，重点做 `string/hex/obj/constant/builtin/comma/anti/dead/member` |
| 逆向脚本集合 (C) | `reverse` | 兼顾可读性与实用性（偏真实混淆） | 默认启用全部插件；默认忽略 `node_modules/dist/build/out/.git` |

> 预设只是在你**不显式传 `--plugins/--ext/--ignore`** 时生效；只要你手动传了这些参数，就会覆盖预设。

> `--passes` 默认是 1：
> - `source` 通常 1~2 足够
> - `bundle` 建议 1（优先速度）
> - `reverse` 可用 2~5（看你目标文件规模与耗时）

## 支持的混淆模式

| 混淆模式 | 插件 | 示例 |
|---------|------|------|
| 字符串数组加密 + 旋转 | strarr | `_0x5678(0x0)` → `"log"` (vm 沙箱动态执行) |
| 十六进制/Unicode 转义 | string | `"\x48\x65"` → `"He"` |
| String.fromCharCode | string | `String.fromCharCode(72)` → `"H"` |
| 数组映射取字符串 | string | `_arr[0]` → `"log"` |
| 十六进制数字 | hex | `0x1a2b` → `6699` |
| 对象字典还原 | obj | `_map["log"]` → `"log"` |
| 包装器函数内联 | obj | `_op["add"](a,b)` → `a+b` |
| 常量传播 | prop | `var k=3; f(k)` → `f(3)` |
| IIFE/包装器内联 | iife | `(function(a){return a+1})(2)` → `2+1` |
| 数值/字符串常量运算 | constant | `1 + 2` → `3`, `"a"+"b"` → `"ab"` |
| 布尔值花指令 | constant | `!0` → `true`, `void 0` → `undefined` |
| 内置函数静态求值 | builtin | `Math.abs(-3)` → `3`, `parseInt("ff",16)` → `255` |
| 控制流平坦化 (A) | control | `"2\|0\|1".split("\|")` 序列驱动 → 线性代码 |
| 控制流平坦化 (B) | control | `var state=0; while(1){switch(state){...}}` 状态机还原 |
| 控制流条件分支 | control | `state = x>0 ? 1 : 2` → `if(x>0){...}else{...}` |
| 位运算分发平坦化 (C) | control | `for(var s=N; s!==void 0;) switch(31&s)` → 单级 `switch(s)` |
| call/apply 包装器 | callapply | `fn.call(null,a,b)` → `fn(a,b)`, `(0,obj.fn)(x)` → `obj.fn(x)` |
| 逗号表达式合并 | comma | `a=1, b=2;` → 两条独立语句 |
| 反调试清理 | anti | `debugger;` / `setInterval(function(){debugger;})` → 删除 |
| 死代码/不可达代码 | dead | `if(false)`/`while(false)`/未用局部函数 → 删除 |
| 计算属性访问 | member | `obj["log"]` → `obj.log` |
| 混淆变量名 | rename | `_0x4a3b2c`/`a0_0x...`/`_$xx` → `_v1` (多模式, scope安全) |

## bundle 拆包（webpack 模块导出）

当输入是 webpack 打包产物时，建议先启用 `--webpack-extract` 把模块映射导出成独立文件，配合你的编辑器/搜索工具做静态分析。

- **识别形态**:
  - IIFE bootstrap: `(function(mods){ ... __webpack_require__ ... })(mods)`
  - webpackChunk push: `(self["webpackChunk..."]=self[... ]||[]).push([[chunkId], modules, runtime?])`
- **输出**:
  - 默认输出到 `输出目录/webpack_modules/` 下，并生成 `modules.json` 映射
  - 每个模块会导出为一个 `*.js` 文件（内容为模块 factory function）
  - 目录模式下如果加 `--webpack-aggregate`，会把所有文件识别出的模块聚合到同一目录（适合真实站点多 chunk）

## VM 混淆分析

内置 VM 混淆检测器，支持两种分发模式：

| 模式 | 特征 | 检测标准 |
|------|------|----------|
| Switch-Dispatch | `while(...){ var op=code[pc++]; switch(op){...} }` | 8+ case, code[pc++] 模式 |
| Handler-Table | `while(...){ handlers[op](...) }` | 5+ 函数赋值, 间接调用 |

使用 `--vm-analyze` 输出：
- 检测结果（类型、置信度、stack/regs/pc 变量名）
- Opcode 语义分类（PUSH_CONST / ADD / JMP / CALL / STORE / LOAD 等 20+ 种）
- JSON 报告文件（`.vm-report.json`）

## 目录结构

```
ast_deobfuscator/
├── package.json
├── src/
│   ├── index.js                      # CLI 入口 + 插件链式执行引擎
│   ├── utils.js                      # 公共工具函数
│   ├── webpack_extract.js             # webpack bundle 模块识别/导出
│   ├── plugins/                       # 17 个反混淆插件
│   │   ├── string_array_decoder.js   # 字符串数组动态解密 (vm 沙箱)
│   │   ├── string_decoder.js         # 转义还原
│   │   ├── string_concat.js          # 字符串拼接还原
│   │   ├── hex_number.js             # 十六进制数字还原
│   │   ├── object_inline.js          # 对象字典/包装器内联
│   │   ├── const_propagation.js      # 常量传播
│   │   ├── iife_inline.js            # IIFE/包装器内联
│   │   ├── call_apply_inline.js      # call/apply/间接调用内联
│   │   ├── constant_folding.js       # 常量折叠
│   │   ├── builtin_static_eval.js    # 安全内置函数静态求值
│   │   ├── control_flow.js           # 控制流平坦化还原 (序列+状态机+条件分支)
│   │   ├── comma_expression.js       # 逗号表达式拆分
│   │   ├── anti_debug.js             # 反调试清理
│   │   ├── dead_code.js              # 死代码删除 (while(false)/未用函数)
│   │   ├── member_expression.js      # 成员表达式简化
│   │   └── rename_vars.js            # 混淆变量重命名 (多模式)
│   └── vm/                            # VM 混淆分析模块
│       ├── vm_detector.js            # VM 混淆模式检测
│       ├── vm_analyzer.js            # VM 结构分析 (stack/regs/bytecode)
│       └── opcode_classifier.js      # Opcode 语义自动分类
└── test/
    ├── sample_obfuscated.js          # 混淆样本
    ├── sample_vm_obfuscated.js       # VM 混淆样本
    └── test.js                       # 单元测试 (57 个用例)
```

## 技术栈

- **AST**: @babel/parser + @babel/traverse + @babel/generator + @babel/types
- **沙箱执行**: Node.js vm 模块 (用于字符串数组动态解密)
- **静态求值**: 对部分内置函数做安全白名单求值 (Math/parseInt/atob/btoa)
- **VM 分析**: 自动检测 switch-dispatch/handler-table VM, opcode 语义分类
- **CLI**: Commander.js + Chalk

## 已应用场景

- 某内容平台 mnsv2 签名 JS 预处理（~98KB VM 代码）
- 某短视频平台 webmssdk SDK 静态分析预处理
- 某 B2B 电商平台 um.js (177KB) 设备指纹模块分析
