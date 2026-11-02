// Offline MCP integration tests: real handler, in-memory Supabase query adapter.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from '../web/node_modules/typescript/lib/typescript.js';
const root = new URL('../', import.meta.url);
const transpile = path => ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const load = (path, deps = {}) => {
  const exports = {};
  vm.runInNewContext(transpile(path), { exports, require: key => { if (!(key in deps)) throw Error(key); return deps[key]; }, Deno: { env: { get: () => '' }, serve: () => {} }, Date, console });
  return exports;
};
const input = load('supabase/functions/_shared/task-input.ts');
test('strict dates, times, timezone timestamps and explicit clearing', () => {
  for (const v of ['2026-02-30', '2026-13-01', '2026-1-01', 123, '0000-01-01']) assert.throws(() => input.nullableDate(v, 'due_date'));
  assert.equal(input.nullableDate('2028-02-29', 'due_date'), '2028-02-29');
  assert.equal(input.nullableDate(null, 'due_date'), null);
  for (const v of ['24:00', '12:60', '9:00', false]) assert.throws(() => input.nullableTime(v));
  assert.equal(input.nullableTime('09:00'), '09:00');
  for (const v of ['2026-11-03T09:00:00', '2026-02-30T09:00:00+09:00', 'invalid']) assert.throws(() => input.nullableReminder(v));
  assert.equal(input.nullableReminder('2026-11-03T09:00:00+09:00'), '2026-11-03T00:00:00.000Z');
  assert.throws(() => input.validateRule({freq: 'month', interval: 1, monthday: 0}));
  assert.throws(() => input.taskPage({limit: 101}));
});

function harness(rows) {
  class Query {
    filters = []; orders = []; start = 0; end = Infinity; patch = null; insertion = null;
    select() { return this; }
    eq(k,v) { this.filters.push(r => r[k] === v); return this; }
    is(k,v) { this.filters.push(r => (r[k] ?? null) === v); return this; }
    contains(k,v) { this.filters.push(r => v.every(t => r[k].includes(t))); return this; }
    or(expression) {
      const evaluate = (part, r) => {
        if (part.startsWith('and(')) return part.slice(4,-1).split(',').every(p=>evaluate(p,r));
        const [key,op,...rest]=part.split('.'); const value=rest.join('.');
        return r[key] != null && (op==='lte' ? r[key]<=value : op==='gt' ? r[key]>value : false);
      };
      const parts=expression.match(/and\([^)]*\)|[^,]+/g);
      this.filters.push(r=>parts.some(part=>evaluate(part,r))); return this;
    }
    order(k,o = {}) { this.orders.push([k,o]); return this; }
    range(s,e) { this.start=s; this.end=e; return this; }
    limit(n) { this.end=n-1; return this; }
    update(p) { this.patch=p; return this; }
    insert(r) { this.insertion=r; return this; }
    execute() {
      if (this.insertion) rows.push({ id: 'created', tags: [], due_date: null, scheduled_date: null, done_at: null, archived: false, deleted_at: null, ...this.insertion });
      let found = rows.filter(r => this.filters.every(f => f(r)));
      if (this.patch) found.forEach(r => Object.assign(r, this.patch));
      found.sort((a,b) => { for (const [k,o] of this.orders) { const x=a[k], y=b[k]; if(x===y) continue; if(x==null) return o.nullsFirst ? -1:1; if(y==null) return o.nullsFirst ? 1:-1; return (x<y?-1:1)*(o.ascending===false?-1:1); } return 0; });
      return { data: found.slice(this.start,this.end+1).map(r => ({...r})), error: null };
    }
    then(resolve,reject) { return Promise.resolve(this.execute()).then(resolve,reject); }
    async maybeSingle() { const result=this.execute(); return {...result,data:result.data[0]??null}; }
    single() { return this.maybeSingle(); }
  }
  const exports = {};
  const deps = {
    '../_shared/integrations.ts': {admin: () => ({from:()=>new Query()}), OWNER_USER_ID:'owner', googleConnected:async()=>false},
    '../_shared/deadline.ts': {},
    '../_shared/repeat.ts': {asRule:r=>r, describeRepeat:()=> '毎日', parseRepeat:()=>({rule:{freq:'day',interval:1}}), firstOccurrence:()=> '2026-11-02', jstToday:()=> '2026-11-02'},
    '../_shared/task-input.ts':input,
  };
  vm.runInNewContext(transpile('supabase/functions/mcp/index.ts')+'\nexports.callTool = callTool;', {exports, require:k=>deps[k], Deno:{env:{get:()=>''},serve:()=>{}}, Date});
  return exports.callTool;
}
const note = i => ({id:String(i).padStart(4,'0'),user_id:'owner',body:'watch memo',source:'watch',created_at:'2026-11-02T00:00:00Z',tags:['買い物'],is_task:true,done_at:null,due_date:null,scheduled_date:null,archived:false,deleted_at:null,priority:0});
test('conversion preserves identity and contents; tags are idempotent; task can revert', async () => {
  const row={...note(1),is_task:false}; const call=harness([row]);
  const args={id:row.id,is_task:true,due_date:null,add_tags:['ワークマン']};
  const first=await call('edit_note',args); await call('edit_note',args);
  assert.equal(first.id,row.id); assert.equal(first.source,'watch'); assert.equal(first.body,'watch memo'); assert.equal(first.created_at,'2026-11-02T00:00:00Z');
  assert.equal(row.tags.length,2);
  assert.equal((await call('list_tasks',{view:'inbox',tag:'買い物'})).tasks.length,1);
  await call('edit_note',{id:row.id,is_task:false}); assert.equal((await call('list_tasks',{view:'inbox'})).tasks.length,0);
});
test('tag filtering and stable pagination return all 235 matching undated tasks', async () => {
  const rows=Array.from({length:235},(_,i)=>note(i)); rows[1].scheduled_date='2026-11-03';
  rows.push({...note(999),tags:['仕事']}, {...note(998),due_date:'2026-11-03'});
  const call=harness(rows); const ids=[]; let offset=0;
  do { const page=await call('list_tasks',{view:'inbox',tag:'買い物',offset}); ids.push(...page.tasks.map(r=>r.id)); offset=page.next_offset; } while(offset!==null);
  assert.equal(ids.length,235); assert.equal(new Set(ids).size,235);
  assert.equal((await call('list_tasks',{view:'all',tag:'仕事'})).tasks.length,1);
});
test('dated tasks appear in upcoming and agenda with explicit reminders', async () => {
  const call=harness([]);
  const tomorrow=new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,10);
  const made=await call('create_note',{body:'dated',is_task:true,due_date:tomorrow,remind_at:`${tomorrow}T09:00:00+09:00`});
  const upcoming=await call('list_tasks',{view:'upcoming'});
  assert.equal(upcoming.tasks[0].id,made.id);
  const agenda=await call('agenda',{days:2});
  assert.equal(agenda.days[1].tasks[0].id,made.id);
  assert.equal(agenda.days[1].tasks[0].remind_at,made.remind_at);
});

test('create and edit share reminder, recurrence, date validation and full response', async () => {
  const call=harness([]);
  const made=await call('create_note',{body:'task',is_task:true,due_date:'2026-11-03',due_time:'09:00',remind_at:'2026-11-03T08:00:00+09:00',repeat_rule:{freq:'day',interval:1}});
  assert.equal(made.remind_at,'2026-11-02T23:00:00.000Z'); assert.equal(made.repeat_text,'毎日');
  await assert.rejects(()=>call('edit_note',{id:made.id,due_date:'2026-02-30'}));
  const edited=await call('edit_note',{id:made.id,remind_at:null,repeat_rule:null,due_date:null,due_time:null});
  assert.equal(edited.due_date,null); assert.equal(edited.repeat_rule,null); assert.equal(edited.remind_at,undefined);
});
