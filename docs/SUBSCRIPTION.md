# 路径订阅容器（Path Subscription Container）

`subscription.js` 在 fast-json-patch 之上提供一个订阅容器：调用方用
JSON Pointer 前缀订阅文档子树，提交一批（batch）JSON Patch 后，只有
**受到影响的订阅者** 会收到通知。

```js
const { createSubscriptionContainer } = require("./subscription.js");
const container = createSubscriptionContainer({ items: ["a", "b"] });

const handle = container.subscribe("/items/1", (event) => {
    console.log(event.pointer, event.indices, event.document);
});
container.applyPatch([{ op: "remove", path: "/items/0" }]); // 会通知 /items/1
handle.unsubscribe();
```

## API

- `createSubscriptionContainer(document)` — 以 `document` 为初始状态创建容器。
- `subscribe(pointer, callback)` — 订阅一个 JSON Pointer 前缀（`""` 表示根）。
  返回句柄 `{ pointer, unsubscribe() }`。
- `unsubscribe(handleOrPointer)` — 按句柄或按指针字符串退订。
- `applyPatch(patch)` — 校验并应用一批操作。成功返回
  `{ document, notified: [{ pointer, indices }] }`；失败抛出 `JsonPatchError`。
- `getDocument()` / `getSubscriberCount()` — 读取当前状态与订阅数。

回调事件对象：`{ pointer, indices, document, patch }`，其中 `indices`
是本批中匹配到该订阅者的操作下标（升序），`document` 是提交后的新状态。

## 订阅影响规则

指针先按 RFC 6901 拆成 token（`~1` → `/`，`~0` → `~`），所有匹配都以
**完整 token** 为单位：`/items/1` 不会匹配 `/items/10`。

对每一个操作，在该操作执行前的文档状态上计算"受影响路径"，订阅者 S
被操作 O 影响，当且仅当满足以下任一条件：

1. **前缀包含（双向）**：S 的 token 序列是 O 路径的前缀（操作发生在订阅
   子树内部），或 O 路径是 S 的前缀（父节点被 replace/remove，后代订阅
   被通知）。
2. **数组下标位移**：O 是数组上的 `add`/`remove`，S 与 O 位于同一父数组，
   且 S 在该位置的下标 `>=` 被插入/删除的下标。因此删除 `/items/0` 会
   通知 `/items/1` 的订阅者，即使字面路径不同；删除更靠后的下标则不会
   影响靠前的订阅。

各操作类型：

| 操作      | 受影响路径                                   |
| --------- | -------------------------------------------- |
| `add`     | `path`（数组插入触发下标位移规则）           |
| `remove`  | `path`（数组删除触发下标位移规则）           |
| `replace` | `path`（不位移）                             |
| `move`    | `from` 按 remove、`path` 按 add，**两侧都算** |
| `copy`    | `path` 按 add（来源不受影响）                |
| `test`    | 不通知（非变更操作）                         |

## 批次语义

- **先校验后提交**：整批操作先 `validate`，再应用到隔离副本
  （`applyPatch(clone, patch, true)`）。任一操作失败时，容器状态保持
  不变（`getDocument()` 连对象 identity 都不变），也不发送任何通知。
- **每批每订阅者只通知一次**：同一订阅者被多个操作命中时合并为一次
  回调，`indices` 携带所有匹配操作的下标。
- **通知快照**：通知列表在回调执行前确定。回调中新增或移除订阅只影响
  下一批，不会改变正在发送的快照。

## 演示与测试

```sh
node examples/subscription-demo.js   # 小状态演示
node test/subscriptionSpec.js        # 局部确定性测试（19 例）
```
