import * as jsonpatch from '../../index.mjs';
import { SubscriptionContainer } from '../../module/subscription.mjs';

describe('SubscriptionContainer', function () {

  describe('basic subscribe / commit / notify', function () {
    it('notifies a subscriber when its exact path is replaced', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      const result = container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(result.success).toBe(true);
      expect(notifications.length).toBe(1);
      expect(notifications[0].matches).toEqual([0]);
      expect(notifications[0].document).toEqual({ a: 2 });
      expect(container.getDocument()).toEqual({ a: 2 });
    });

    it('notifies a subscriber when a descendant path is added', function () {
      const container = new SubscriptionContainer({ a: { b: 1 } });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      container.commit([{ op: 'add', path: '/a/c', value: 2 }]);

      expect(notifications.length).toBe(1);
      expect(notifications[0].matches).toEqual([0]);
    });

    it('does not notify an unaffected subscriber', function () {
      const container = new SubscriptionContainer({ a: 1, b: 2 });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/b', value: 3 }]);

      expect(notifications.length).toBe(0);
    });

    it('notifies multiple subscribers in one commit', function () {
      const container = new SubscriptionContainer({ a: 1, b: 2 });
      const notified = [];
      container.subscribe('/a', () => notified.push('a'));
      container.subscribe('/b', () => notified.push('b'));
      container.commit([
        { op: 'replace', path: '/a', value: 10 },
        { op: 'replace', path: '/b', value: 20 }
      ]);

      expect(notified.sort()).toEqual(['a', 'b']);
    });

    it('notifies the root subscriber for every operation', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(notifications.length).toBe(1);
    });
  });

  describe('array index shifting', function () {
    it('notifies /items/1 when /items/0 is removed (literal path differs)', function () {
      const container = new SubscriptionContainer({ items: ['a', 'b', 'c'] });
      const notifications = [];
      container.subscribe('/items/1', n => notifications.push(n));
      container.commit([{ op: 'remove', path: '/items/0' }]);

      expect(notifications.length).toBe(1);
      expect(notifications[0].matches).toEqual([0]);
      expect(container.getDocument()).toEqual({ items: ['b', 'c'] });
    });

    it('notifies subsequent indices when inserting at the front', function () {
      const container = new SubscriptionContainer({ items: ['a', 'b'] });
      const affected = [];
      for (let i = 0; i < 2; i++) {
        container.subscribe('/items/' + i, () => affected.push(i));
      }
      container.commit([{ op: 'add', path: '/items/0', value: 'x' }]);

      expect(affected.sort()).toEqual([0, 1]);
    });

    it('does not notify indices before the insertion point', function () {
      const container = new SubscriptionContainer({ items: ['a', 'b', 'c'] });
      const affected = [];
      for (let i = 0; i < 3; i++) {
        container.subscribe('/items/' + i, () => affected.push(i));
      }
      container.commit([{ op: 'add', path: '/items/2', value: 'x' }]);

      // indices 0 and 1 are unaffected; 2 shifts to 3
      expect(affected.sort()).toEqual([2]);
    });

    it('notifies descendant subscriptions of a shifted array element', function () {
      const container = new SubscriptionContainer({ items: [{ name: 'a' }, { name: 'b' }] });
      const notifications = [];
      container.subscribe('/items/1/name', n => notifications.push(n));
      container.commit([{ op: 'remove', path: '/items/0' }]);

      expect(notifications.length).toBe(1);
    });

    it('does not shift on replace', function () {
      const container = new SubscriptionContainer({ items: ['a', 'b'] });
      const notifications = [];
      container.subscribe('/items/1', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/items/0', value: 'x' }]);

      expect(notifications.length).toBe(0);
    });
  });

  describe('move', function () {
    it('notifies both source and target subscribers', function () {
      const container = new SubscriptionContainer({ a: 1, b: 2 });
      const notified = [];
      container.subscribe('/a', () => notified.push('a'));
      container.subscribe('/b', () => notified.push('b'));
      container.commit([{ op: 'move', from: '/a', path: '/b' }]);

      expect(notified.sort()).toEqual(['a', 'b']);
    });

    it('notifies the source subtree on move', function () {
      const container = new SubscriptionContainer({ a: { x: 1 }, b: {} });
      const notifications = [];
      container.subscribe('/a/x', n => notifications.push(n));
      container.commit([{ op: 'move', from: '/a/x', path: '/b/y' }]);

      expect(notifications.length).toBe(1);
    });

    it('only affects the index range when moving within the same array', function () {
      const container = new SubscriptionContainer({ items: ['a', 'b', 'c', 'd'] });
      const affected = [];
      for (let i = 0; i < 4; i++) {
        container.subscribe('/items/' + i, () => affected.push(i));
      }
      container.commit([{ op: 'move', from: '/items/0', path: '/items/2' }]);

      // 0 (moved), 1 and 2 (shift); 3 is unaffected
      expect(affected.sort()).toEqual([0, 1, 2]);
    });
  });

  describe('copy', function () {
    it('notifies the target but not the source on copy', function () {
      const container = new SubscriptionContainer({ a: 1, b: 2 });
      const notified = [];
      container.subscribe('/a', () => notified.push('a'));
      container.subscribe('/b', () => notified.push('b'));
      container.commit([{ op: 'copy', from: '/a', path: '/b' }]);

      expect(notified).toEqual(['b']);
    });
  });

  describe('parent replacement notifies descendants', function () {
    it('notifies a descendant when its parent is replaced', function () {
      const container = new SubscriptionContainer({ items: { 0: { name: 'x' } } });
      const notifications = [];
      container.subscribe('/items/0/name', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/items/0', value: { name: 'y' } }]);

      expect(notifications.length).toBe(1);
    });

    it('notifies a descendant when an ancestor is removed', function () {
      const container = new SubscriptionContainer({ a: { b: { c: 1 } } });
      const notifications = [];
      container.subscribe('/a/b/c', n => notifications.push(n));
      container.commit([{ op: 'remove', path: '/a/b' }]);

      expect(notifications.length).toBe(1);
    });
  });

  describe('test operation', function () {
    it('does not notify on a passing test', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      container.commit([{ op: 'test', path: '/a', value: 1 }]);

      expect(notifications.length).toBe(0);
    });
  });

  describe('notify once with matching operation indices', function () {
    it('notifies once with all matching op indices', function () {
      const container = new SubscriptionContainer({ items: [1, 2, 3] });
      const notifications = [];
      container.subscribe('/items/0', n => notifications.push(n));
      container.commit([
        { op: 'replace', path: '/items/0', value: 10 },
        { op: 'replace', path: '/items/1', value: 20 },
        { op: 'replace', path: '/items/0', value: 30 }
      ]);

      expect(notifications.length).toBe(1);
      expect(notifications[0].matches).toEqual([0, 2]);
    });
  });

  describe('invalid patch', function () {
    it('leaves the document unchanged and sends no notification on failure', function () {
      const container = new SubscriptionContainer({ items: [1, 2] });
      const docBefore = JSON.stringify(container.getDocument());
      const notifications = [];
      container.subscribe('/items/0', n => notifications.push(n));
      const result = container.commit([{ op: 'remove', path: '/items/5' }]);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(container.getDocument()).toEqual(JSON.parse(docBefore));
      expect(notifications.length).toBe(0);
    });

    it('does not partially apply a batch where a later op is invalid', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const docBefore = JSON.stringify(container.getDocument());
      const result = container.commit([
        { op: 'replace', path: '/a', value: 2 },
        { op: 'remove', path: '/missing' }
      ]);

      expect(result.success).toBe(false);
      expect(container.getDocument()).toEqual(JSON.parse(docBefore));
    });

    it('rejects a patch that is not an array', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const result = container.commit({ op: 'replace', path: '/a', value: 2 });

      expect(result.success).toBe(false);
      expect(result.error.name).toBe('SEQUENCE_NOT_AN_ARRAY');
    });

    it('rejects an operation with an invalid op', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const result = container.commit([{ op: 'frobnicate', path: '/a' }]);

      expect(result.success).toBe(false);
      expect(result.error.name).toBe('OPERATION_OP_INVALID');
    });

    it('rejects an add without a value', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const result = container.commit([{ op: 'add', path: '/b' }]);

      expect(result.success).toBe(false);
      expect(result.error.name).toBe('OPERATION_VALUE_REQUIRED');
    });

    it('rejects a move without a from field', function () {
      const container = new SubscriptionContainer({ a: 1, b: 2 });
      const result = container.commit([{ op: 'move', path: '/b' }]);

      expect(result.success).toBe(false);
      expect(result.error.name).toBe('OPERATION_FROM_REQUIRED');
    });

    it('rejects a path that does not start with /', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const result = container.commit([{ op: 'replace', path: 'a', value: 2 }]);

      expect(result.success).toBe(false);
      expect(result.error.name).toBe('OPERATION_PATH_INVALID');
    });

    it('rejects a failing test and does not notify', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      const result = container.commit([{ op: 'test', path: '/a', value: 999 }]);

      expect(result.success).toBe(false);
      expect(result.error.name).toBe('TEST_OPERATION_FAILED');
      expect(notifications.length).toBe(0);
    });
  });

  describe('prefix token boundary', function () {
    it('does not match /items2 when subscribed to /items', function () {
      const container = new SubscriptionContainer({ items: [1], items2: [2] });
      const notifications = [];
      container.subscribe('/items', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/items2/0', value: 99 }]);

      expect(notifications.length).toBe(0);
    });

    it('matches the exact prefix and deeper paths', function () {
      const container = new SubscriptionContainer({ items: { 0: { name: 'a' } } });
      const notifications = [];
      container.subscribe('/items', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/items/0/name', value: 'b' }]);

      expect(notifications.length).toBe(1);
    });
  });

  describe('snapshot semantics during dispatch', function () {
    it('a subscription added during dispatch does not receive the current batch', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const calls = [];
      container.subscribe('/a', () => {
        calls.push('s1');
        container.subscribe('/a', () => calls.push('s2'));
      });
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(calls).toEqual(['s1']);

      calls.length = 0;
      container.commit([{ op: 'replace', path: '/a', value: 3 }]);
      expect(calls).toEqual(['s1', 's2']);
    });

    it('a subscription removed during dispatch still receives the current batch', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const calls = [];
      const sub = container.subscribe('/a', () => {
        calls.push('s');
        container.unsubscribe(sub);
      });
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(calls).toEqual(['s']);

      calls.length = 0;
      container.commit([{ op: 'replace', path: '/a', value: 3 }]);
      expect(calls).toEqual([]);
    });

    it('unsubscribing a different subscription during dispatch still notifies it for the current batch', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const calls = [];
      const subA = container.subscribe('/a', () => calls.push('a'));
      container.subscribe('/a', () => {
        calls.push('b');
        container.unsubscribe(subA);
      });
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(calls.sort()).toEqual(['a', 'b']);

      calls.length = 0;
      container.commit([{ op: 'replace', path: '/a', value: 3 }]);
      expect(calls).toEqual(['b']);
    });
  });

  describe('unsubscribe', function () {
    it('stops notifications after unsubscribe', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      const sub = container.subscribe('/a', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);
      expect(notifications.length).toBe(1);

      container.unsubscribe(sub);
      container.commit([{ op: 'replace', path: '/a', value: 3 }]);
      expect(notifications.length).toBe(1);
    });
  });

  describe('integration with fast-json-patch core', function () {
    it('works through the default export', function () {
      const container = new jsonpatch.SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(notifications.length).toBe(1);
      expect(container.getDocument()).toEqual({ a: 2 });
    });
  });
  describe('edge cases', function () {
    it('an empty patch succeeds and notifies nobody', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('/a', n => notifications.push(n));
      const result = container.commit([]);

      expect(result.success).toBe(true);
      expect(notifications.length).toBe(0);
      expect(container.getDocument()).toEqual({ a: 1 });
    });

    it('works with a root array document', function () {
      const container = new SubscriptionContainer(['a', 'b', 'c']);
      const notifications = [];
      container.subscribe('/1', n => notifications.push(n));
      container.commit([{ op: 'remove', path: '/0' }]);

      expect(notifications.length).toBe(1);
      expect(container.getDocument()).toEqual(['b', 'c']);
    });

    it('handles escaped tokens in paths', function () {
      const container = new SubscriptionContainer({ 'a/b': { c: 1 } });
      const notifications = [];
      container.subscribe('/a~1b/c', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/a~1b/c', value: 2 }]);

      expect(notifications.length).toBe(1);
    });

    it('normalizes a prefix without a leading slash', function () {
      const container = new SubscriptionContainer({ a: 1 });
      const notifications = [];
      container.subscribe('a', n => notifications.push(n));
      container.commit([{ op: 'replace', path: '/a', value: 2 }]);

      expect(notifications.length).toBe(1);
    });
  });
});
