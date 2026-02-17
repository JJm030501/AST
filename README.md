# ast-deobfuscator

A Babel-based JavaScript deobfuscation CLI tool with 17 transformation plugins, webpack module extraction, and VM bytecode analysis.

Built from real-world reverse engineering needs — tested against production obfuscated code from major platforms (170KB+ files, custom VM interpreters, bitwise control flow).

[中文文档](./README.zh-CN.md)

## Quick Start

```bash
npm install
npx deob -i obfuscated.js -o clean.js
```

## Before / After

```js
// Before
var _0x3f2a = 0x1a2b;
window["\x63\x6f\x6e\x73\x6f\x6c\x65"]["\x6c\x6f\x67"](!0);
_0xa1 = 1, _0xa2 = 2, _0xa3 = _0xa1 + _0xa2;
if (false) { console.log("dead"); }
```

```js
// After
var _0x3f2a = 6699;
window.console.log(true);
_0xa1 = 1;
_0xa2 = 2;
_0xa3 = _0xa1 + _0xa2;
```

## Plugins (17)

Plugins execute in a carefully ordered pipeline — each stage feeds the next:

```
strarr → string → strconcat → hex → obj → prop → iife → callapply
→ constant → builtin → control → comma → strconcat → anti → dead → member → rename
```

| Plugin | What it does | Example |
|--------|-------------|---------|
| **strarr** | Decrypt string array (vm sandbox) | `_0x5678(0x0)` → `"log"` |
| **string** | Restore hex/unicode escapes, fromCharCode | `"\x48\x65"` → `"He"` |
| **strconcat** | Fold split string concatenation | `s="se"; s+="t"; s+="Item"` → `s="setItem"` |
| **hex** | Hex number literals to decimal | `0x1a2b` → `6699` |
| **obj** | Inline object dictionaries & wrappers | `_op["add"](a,b)` → `a+b` |
| **prop** | Constant propagation | `var k=3; f(k)` → `f(3)` |
| **iife** | Inline IIFE / wrapper functions | `(function(a){return a+1})(2)` → `2+1` |
| **callapply** | Simplify call/apply/indirect calls | `fn.call(null,a)` → `fn(a)` |
| **constant** | Constant folding | `1+2` → `3`, `!0` → `true` |
| **builtin** | Static eval of safe builtins | `Math.abs(-3)` → `3` |
| **control** | Unflatten control flow (3 patterns) | while-switch → linear code |
| **comma** | Split comma expressions | `a=1, b=2` → two statements |
| **anti** | Remove anti-debug code | `debugger` / `setInterval(debugger)` → removed |
| **dead** | Remove dead code & unused functions | `if(false){...}` → removed |
| **member** | Simplify member expressions | `obj["log"]` → `obj.log` |
| **rename** | Rename obfuscated variables | `_0x4a3b2c` → `_v1` |

### Control Flow Patterns

The `control` plugin handles three distinct patterns:

| Pattern | Source | Structure |
|---------|--------|-----------|
| **A — Sequence** | obfuscator.io | `"2\|0\|1".split("\|")` + index counter |
| **B — State Machine** | obfuscator.io | `var state=0; while(1){switch(state){...}}` |
| **C — Bitwise Dispatch** | Custom (e.g. Alibaba) | `for(var s=N; s!==void 0;){ switch(31&s){case 0: !function(){switch(Da){...}}()}}` |

Pattern C flattens deeply nested IIFE-wrapped switches (3+ levels of bit-shifted dispatch) into a single flat `switch(state)`.

### String Concat Patterns

The `strconcat` plugin handles:

```js
// Simple chain
s = "se"; s += "tRequ"; s += "estHea"; s += "der";  →  s = "setRequestHeader"

// With .split("").reverse().join("")
d = "ev"; d += "itim"; d = (d += "irPot").split("").reverse().join("");  →  d = "toPrimitive"

// Cross-assignment
Ge = "st"; Ue = Ge += "ring";  →  Ge = "string"; Ue = Ge;
```

## Usage

```bash
# All plugins (default)
npx deob -i input.js -o output.js

# Select specific plugins
npx deob -i input.js -o output.js --plugins string,hex,constant,member

# Multiple passes (for layered obfuscation)
npx deob -i input.js -o output.js --passes 3

# Directory batch processing
npx deob -i ./src -o ./src_clean

# Scene presets
npx deob -i ./dist -o ./dist_clean --scene bundle
npx deob -i ./dump -o ./dump_clean --scene reverse

# Webpack module extraction
npx deob -i app.bundle.js -o app.clean.js --webpack-extract

# VM bytecode analysis
npx deob -i vm_code.js -o vm_code.clean.js --vm-analyze
```

### Scene Presets

| Scene | `--scene` | Strategy |
|-------|-----------|----------|
| Source code | `source` | All plugins; ignores `node_modules/dist/build` |
| Bundle | `bundle` | Safe plugins only (no `strarr/control/rename`) |
| Reverse engineering | `reverse` | All plugins; aggressive mode |

## Webpack Module Extraction

Recognizes two webpack patterns:
- **IIFE bootstrap**: `(function(mods){ ... __webpack_require__ ... })(mods)`
- **webpackChunk push**: `(self["webpackChunk..."]=self[...]||[]).push([[id], modules])`

Extracts each module as a standalone `.js` file with a `modules.json` mapping.

```bash
# Extract modules from bundle
npx deob -i dist/app.js -o dist_clean/app.js --webpack-extract

# Aggregate modules from multiple chunks
npx deob -i ./dist -o ./dist_clean --webpack-extract --webpack-aggregate
```

## VM Bytecode Analysis

Detects and analyzes VM-based obfuscation with `--vm-analyze`:

| VM Type | Detection | Output |
|---------|-----------|--------|
| Switch-Dispatch | `while(...){ switch(code[pc++]){...} }` | Stack/register vars, opcode semantics |
| Handler-Table | `while(...){ handlers[op](...) }` | Handler functions, call patterns |

Classifies opcodes into 20+ semantic categories (PUSH_CONST, ADD, JMP, CALL, STORE, LOAD, etc.) and outputs a `.vm-report.json`.

## Real-World Results

Tested on production obfuscated files:

| File | Size | Lines (before → after) | Transforms | Key plugins |
|------|------|----------------------|------------|-------------|
| SHEIN gw_auth_main.js | 179KB | 2 → 8,959 | 1,192 | string, constant, comma, dead |
| SHEIN infp_armor.js | 389KB | 4 → 14,142 | 1,499 | string, prop, callapply, constant, comma |
| Alibaba um.js | 174KB | 1 → 16,454 | 3,500+ | string, strconcat, constant, control, comma, dead |

## Project Structure

```
ast_deobfuscator/
├── src/
│   ├── index.js              # CLI + plugin pipeline engine
│   ├── utils.js              # Shared utilities
│   ├── webpack_extract.js    # Webpack module extraction
│   ├── plugins/              # 17 transformation plugins
│   │   ├── string_array_decoder.js
│   │   ├── string_decoder.js
│   │   ├── string_concat.js
│   │   ├── hex_number.js
│   │   ├── object_inline.js
│   │   ├── const_propagation.js
│   │   ├── iife_inline.js
│   │   ├── call_apply_inline.js
│   │   ├── constant_folding.js
│   │   ├── builtin_static_eval.js
│   │   ├── control_flow.js
│   │   ├── comma_expression.js
│   │   ├── anti_debug.js
│   │   ├── dead_code.js
│   │   ├── member_expression.js
│   │   └── rename_vars.js
│   └── vm/
│       ├── vm_detector.js
│       ├── vm_analyzer.js
│       └── opcode_classifier.js
└── test/
    └── test.js               # 55 test cases
```

## Tech Stack

- **AST**: @babel/parser + @babel/traverse + @babel/generator + @babel/types
- **Sandbox**: Node.js `vm` module (string array decryption)
- **CLI**: Commander.js + Chalk

## License

MIT
