/*!
 * 小状态演示 (Small state demo)
 *
 * 运行: node demo/subscriptionDemo.mjs
 *
 * 演示一个购物车状态的订阅容器：订阅者关注购物车商品、商品数量、以及根状态。
 * 提交一批 patch 后，只有受影响的订阅者被通知，且每批只通知一次。
 */
import { SubscriptionContainer } from '../module/subscription.mjs';

// ---- 初始状态 ----
const cart = {
  items: [
    { sku: 'apple', qty: 1 },
    { sku: 'banana', qty: 2 }
  ],
  coupon: null
};

const container = new SubscriptionContainer(cart);

// ---- 订阅 ----
const events = [];
container.subscribe('/items', n => events.push('items 受影响, 操作下标: [' + n.matches + ']'));
container.subscribe('/items/0/qty', n => events.push('apple 数量受影响, 操作下标: [' + n.matches + ']'));
container.subscribe('', n => events.push('根状态受影响, 操作下标: [' + n.matches + ']'));

function commit(label, patch) {
  events.length = 0;
  const result = container.commit(patch);
  console.log('\n=== ' + label + ' ===');
  console.log('patch:', JSON.stringify(patch));
  console.log('结果:', result.success ? '成功' : '失败: ' + result.error.name);
  console.log('通知:', events.length ? events : '(无)');
  console.log('当前状态:', JSON.stringify(container.getDocument()));
}

// 1. 修改 apple 数量 -> 精确匹配 + 父订阅 + 根订阅
commit('修改 apple 数量', [
  { op: 'replace', path: '/items/0/qty', value: 5 }
]);

// 2. 删除 apple (items/0) -> 订阅 /items/0/qty 应被通知（父节点被移除）
commit('删除 apple', [
  { op: 'remove', path: '/items/0' }
]);

// 3. 插入新商品到最前 -> 后续下标平移，/items 与根订阅被通知
commit('插入 cherry 到最前', [
  { op: 'add', path: '/items/0', value: { sku: 'cherry', qty: 3 } }
]);

// 4. move: 把 cherry (items/0) 移到末尾 (items/1) -> 来源和目标都通知
commit('移动 cherry 到末尾', [
  { op: 'move', from: '/items/0', path: '/items/1' }
]);

// 5. 非法 patch: 对不存在的路径 replace -> 整批回滚，不通知
commit('非法 patch (回滚)', [
  { op: 'replace', path: '/items/0/qty', value: 99 },
  { op: 'replace', path: '/not/exist', value: 1 }
]);

// 6. test 操作不通知
commit('test 不触发通知', [
  { op: 'test', path: '/coupon', value: null }
]);

console.log('\n=== 演示结束 ===');
