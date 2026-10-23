import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const routes = [
  ['/', '主页'],
  ['/services', '服务'],
  ['/requests', '接口'],
  ['/databases', '数据库'],
  ['/mcp-tools', 'MCP 工具'],
  ['/commands', '命令行'],
  ['/tests', '已保存用例'],
  ['/flows', '流程'],
  ['/execution-records', '执行记录'],
  ['/logs', '日志'],
  ['/ai-tools', 'AI 工具'],
] as const;
const browserProblems = new WeakMap<Page, string[]>();

async function noDocumentOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(
    sizes.content,
    'Wide data should scroll inside its panel, without overflowing the document',
  ).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function select(page: Page, label: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}

async function getJSON(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

test.beforeEach(async ({ request, page }) => {
  const errors: string[] = [];
  browserProblems.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const health = await getJSON(request, '/health');
  expect(health).toMatchObject({ service: 'apix-runtime', status: 'ok' });
});
test.afterEach(async ({ page }) => {
  expect(
    browserProblems.get(page) || [],
    'No JavaScript, CSP or resource errors in the browser',
  ).toEqual([]);
});

test('every production route renders, survives refresh and has no browser errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  for (const [route, title] of routes) {
    await test.step(`${route} renders`, async () => {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.getByText('实时同步中', { exact: true })).toBeVisible();
      await expect(page.getByText('页面暂时无法加载', { exact: true })).toHaveCount(0);
      await noDocumentOverflow(page);
    });
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI 工具', level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test('legacy entry points normalize to the new routes', async ({ page }) => {
  for (const [entry, canonical, title] of [
    ['/activity', '/', '主页'],
    ['/test-collections', '/execution-records', '执行记录'],
    ['/tests?tab=records&type=single', '/execution-records', '执行记录'],
    ['/flows?tab=records', '/execution-records', '执行记录'],
  ] as const) {
    await page.goto(entry);
    await expect(page).toHaveURL((url) => url.pathname + url.search === canonical);
    await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
  }
});

test('desktop and narrow workspaces capture evidence without document overflow', async ({
  page,
}, info) => {
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [route, title, file] of [
      ['/', '主页', 'home'],
      ['/services', '服务', 'services'],
      ['/requests', '接口', 'requests'],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
      await expect(page.getByText('实时同步中', { exact: true })).toBeVisible();
      await noDocumentOverflow(page);
      if (viewport.width < 768) {
        await page.getByRole('button', { name: '打开导航', exact: true }).click();
        await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
        await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
      }
      const path = info.outputPath(`${file}-${viewport.width}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await info.attach(`${title} ${viewport.width}px`, { path, contentType: 'image/png' });
    }
  }
});

test.describe('isolated database workflows', () => {
  test.skip(
    process.env.APIX_E2E_ISOLATED !== '1',
    'Mutation tests require a runtime using a temporary database and APIX_E2E_ISOLATED=1.',
  );

  test('services can be saved, edited, inspected and archived without starting a process', async ({
    page,
    request,
  }) => {
    const name = `e2e-service-${randomUUID()}`;
    let id = '';
    const launches: string[] = [];
    page.on('request', (call) => {
      if (/\/api\/services\/[^/]+\/start$/.test(new URL(call.url()).pathname))
        launches.push(call.url());
    });
    try {
      await page.goto('/services');
      await page.getByRole('button', { name: '新增服务', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新增服务', exact: true });
      await dialog.getByLabel('服务名称', { exact: true }).fill(name);
      await dialog
        .getByLabel('工作目录', { exact: true })
        .fill(process.env.APIX_E2E_WORK_DIR || process.cwd());
      await dialog.getByLabel('启动程序', { exact: true }).fill('__apix_e2e_never_execute__');
      await dialog
        .getByLabel('健康检查地址', { exact: true })
        .fill('http://127.0.0.1:1/e2e-missing');
      const [savedResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/services' &&
            response.request().method() === 'PUT',
        ),
        dialog.getByRole('button', { name: '仅保存', exact: true }).click(),
      ]);
      expect(savedResponse.ok()).toBeTruthy();
      const saved = await savedResponse.json();
      id = saved.id;
      await expect(dialog).toBeHidden();
      const card = page
        .locator('[data-slot="card"]')
        .filter({ has: page.getByText(name, { exact: true }) });
      await expect(card).toBeVisible();
      const details = await getJSON(request, `/api/services/${id}`);
      expect(details.definition).toMatchObject({ name, command: '__apix_e2e_never_execute__' });
      expect(details.instance).toMatchObject({ status: 'stopped' });
      expect(details.instance.pid || 0).toBe(0);
      await card.getByRole('button', { name: '编辑', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '编辑服务', exact: true });
      await editor.getByLabel('服务名称', { exact: true }).fill(`${name}-edited`);
      await editor.getByRole('button', { name: '保存修改', exact: true }).click();
      await expect(editor).toBeHidden();
      await expect
        .poll(async () => (await getJSON(request, `/api/services/${id}`)).definition.name)
        .toBe(`${name}-edited`);
      const editedCard = page
        .locator('[data-slot="card"]')
        .filter({ has: page.getByText(`${name}-edited`, { exact: true }) });
      await editedCard.getByRole('button', { name: '查看详情', exact: true }).click();
      const detail = page.getByRole('dialog', { name: `${name}-edited`, exact: true });
      await expect(detail.getByText('__apix_e2e_never_execute__', { exact: true })).toBeVisible();
      await detail.getByRole('button', { name: /^(关闭|Close)$/ }).click();
      await editedCard.getByRole('button', { name: '归档', exact: true }).click();
      await page.getByRole('button', { name: '确认归档', exact: true }).click();
      await expect(editedCard).toBeHidden();
      const archived = await getJSON(request, '/api/services?archived=true');
      expect(archived.some((item: { id: string }) => item.id === id)).toBe(true);
      expect(launches).toEqual([]);
    } finally {
      if (id) await request.post(`/api/services/${id}/archive`);
    }
  });

  test('HTTP import, saved request execution and persisted history work through the real runtime', async ({
    page,
    request,
    baseURL,
  }) => {
    const groupName = `e2e-group-${randomUUID()}`;
    const requestName = `e2e-request-${randomUUID()}`;
    const healthURL = new URL(`/health?e2e=${randomUUID()}`, baseURL!).toString();
    let groupID = '';
    let requestID = '';
    try {
      await page.goto('/requests');
      await page.getByRole('tab', { name: '接口管理', exact: true }).click();
      await page.getByRole('button', { name: '新建分组', exact: true }).click();
      const collection = page.getByRole('dialog', { name: '新建分组', exact: true });
      await collection.getByLabel('分组名称', { exact: true }).fill(groupName);
      const [groupResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/collections' &&
            response.request().method() === 'POST',
        ),
        collection.getByRole('button', { name: '保存分组', exact: true }).click(),
      ]);
      expect(groupResponse.status()).toBe(201);
      groupID = (await groupResponse.json()).id;
      await expect(collection).toBeHidden();
      await page.getByText('导入 cURL / 原始 HTTP', { exact: true }).click();
      await page
        .getByLabel('请求内容', { exact: true })
        .fill(`curl -H 'X-E2E: migration' '${healthURL}'`);
      await page.getByRole('button', { name: '解析到编辑器', exact: true }).click();
      await expect(page.getByRole('tab', { name: '接口执行', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByLabel('请求地址', { exact: true })).toHaveValue(healthURL);
      await expect(
        page.getByText('已解析为草稿，尚未发送或保存。请检查内容后操作。', { exact: true }),
      ).toBeVisible();
      await page.getByLabel('接口名称', { exact: true }).fill(requestName);
      await select(page, '保存分组', groupName);
      const [saveResponse] = await Promise.all([
        page.waitForResponse((response) =>
          /\/api\/working-copies\/[^/]+\/save$/.test(new URL(response.url()).pathname),
        ),
        page.getByRole('button', { name: '保存接口', exact: true }).click(),
      ]);
      expect(saveResponse.ok()).toBeTruthy();
      requestID = (await saveResponse.json()).api_request_id;
      await expect(page.getByText('接口已保存到接口库。', { exact: true })).toBeVisible();
      const definition = await getJSON(request, `/api/requests/${requestID}`);
      expect(definition).toMatchObject({
        name: requestName,
        collection_id: groupID,
        request: { method: 'GET', url: healthURL },
      });
      const [runResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/runs' &&
            response.request().method() === 'POST',
        ),
        page.getByRole('button', { name: '发送请求', exact: true }).click(),
      ]);
      expect(runResponse.status()).toBe(201);
      const run = await runResponse.json();
      expect(run).toMatchObject({
        status: 'succeeded',
        response_status: 200,
        response_body: { service: 'apix-runtime', status: 'ok' },
      });
      await expect(page.getByText('HTTP 200', { exact: true })).toBeVisible();
      const persisted = await getJSON(request, `/api/runs/${run.id}`);
      expect(persisted).toMatchObject({
        id: run.id,
        api_request_id: requestID,
        request_snapshot: { url: healthURL },
      });
      await page.reload();
      await page.getByRole('tab', { name: '执行记录', exact: true }).click();
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('button', { name: healthURL, exact: true }) });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: healthURL, exact: true }).click();
      const detail = page.getByRole('dialog', { name: '请求与响应详情', exact: true });
      await expect(detail.getByText('HTTP 200', { exact: true })).toBeVisible();
      await expect(detail.getByText(/"service": "apix-runtime"/)).toBeVisible();
      await detail.getByRole('button', { name: /^(关闭|Close)$/ }).click();
      await row.getByRole('button', { name: '固定', exact: true }).click();
      await expect(row.getByRole('button', { name: '取消固定', exact: true })).toBeVisible();
      expect((await getJSON(request, `/api/runs/${run.id}`)).is_pinned).toBe(true);
      await row.getByRole('button', { name: '取消固定', exact: true }).click();
      await expect(row.getByRole('button', { name: '固定', exact: true })).toBeVisible();
    } finally {
      if (requestID) await request.delete(`/api/requests/${requestID}`);
      if (groupID) await request.delete(`/api/collections/${groupID}`);
    }
  });

  test('SQL invalid parameters and missing connections fail safely without a database server', async ({
    page,
    request,
  }) => {
    const id = `e2e-db-${randomUUID()}`;
    const name = `e2e-sql-${randomUUID()}`;
    const saved = await request.put('/api/database/connections', {
      data: {
        id,
        edit_version: 0,
        name,
        type: 'postgresql',
        host: '127.0.0.1',
        port: 1,
        database: 'e2e',
        username: 'e2e',
        ssl_mode: 'disable',
        password: '',
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    try {
      let executions = 0;
      page.on('request', (call) => {
        if (new URL(call.url()).pathname === '/api/database/execute') executions++;
      });
      await page.goto('/databases');
      await page.getByRole('tab', { name: 'SQL 执行', exact: true }).click();
      await select(page, '数据库连接', `${name} · PostgreSQL`);
      await page.getByLabel('SQL 语句', { exact: true }).fill('SELECT $1');
      await page.getByLabel('绑定参数（JSON 数组）', { exact: true }).fill('{invalid');
      await page.getByRole('button', { name: '执行 SQL', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('绑定参数必须是有效的 JSON 数组');
      expect(executions).toBe(0);
      await expect(page.getByLabel('SQL 语句', { exact: true })).toHaveValue('SELECT $1');
      await expect(page.getByLabel('绑定参数（JSON 数组）', { exact: true })).toHaveValue(
        '{invalid',
      );
      const missing = await request.post('/api/database/execute', {
        data: {
          connection_id: `missing-${id}`,
          mode: 'query',
          sql: 'SELECT 1',
          params: [],
          timeout_ms: 1000,
          max_rows: 1,
        },
      });
      expect(missing.status()).toBe(404);
      expect(await missing.json()).toHaveProperty('error');
      await noDocumentOverflow(page);
    } finally {
      await request.post(`/api/database/connections/${id}/archive`);
    }
  });

  test('flow creation, editing, local execution and durable run links survive reload', async ({
    page,
    request,
    baseURL,
  }) => {
    const name = `e2e-flow-${randomUUID()}`;
    let id = '';
    try {
      await page.goto('/flows');
      await page.getByRole('button', { name: '新建多步流程', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新建多步流程', exact: true });
      await dialog.getByLabel('新流程名称', { exact: true }).fill(name);
      const [created] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/flows' &&
            response.request().method() === 'POST',
        ),
        dialog.getByRole('button', { name: '创建流程', exact: true }).click(),
      ]);
      expect(created.status()).toBe(201);
      id = (await created.json()).id;
      await expect(page).toHaveURL(new RegExp(`/flows\\?id=${encodeURIComponent(id)}$`));
      await page.getByRole('button', { name: '添加HTTP 请求', exact: true }).click();
      await page.getByLabel('步骤 1 名称', { exact: true }).fill('Local runtime health');
      await page
        .getByLabel('请求地址', { exact: true })
        .fill(new URL('/health', baseURL!).toString());
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect
        .poll(async () => (await getJSON(request, `/api/flows/${id}`)).steps?.[0]?.request?.url)
        .toBe(new URL('/health', baseURL!).toString());
      await page.reload();
      await expect(page.getByRole('heading', { name, level: 1, exact: true })).toBeVisible();
      await expect(page.getByLabel('步骤 1 名称', { exact: true })).toHaveValue(
        'Local runtime health',
      );
      const [started] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/flows/${id}/runs` &&
            response.request().method() === 'POST',
        ),
        page.getByRole('button', { name: '运行流程', exact: true }).click(),
      ]);
      expect(started.status()).toBe(202);
      const runID = (await started.json()).id;
      await expect(page).toHaveURL(new RegExp(`run=${encodeURIComponent(runID)}`));
      await expect
        .poll(async () => (await getJSON(request, `/api/flow-runs/${runID}`)).status)
        .toBe('succeeded');
      const run = await getJSON(request, `/api/flow-runs/${runID}`);
      expect(run.steps).toHaveLength(1);
      await page.goto(
        `/execution-records?type=flow&id=${encodeURIComponent(id)}&run=${encodeURIComponent(runID)}&step=${encodeURIComponent(run.steps[0].id)}`,
      );
      await expect(page.getByText(name, { exact: false })).toBeVisible();
      await expect(page.getByText('HTTP 200', { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText('HTTP 200', { exact: true })).toBeVisible();
      await noDocumentOverflow(page);
    } finally {
      if (id) await request.delete(`/api/flows/${id}`);
    }
  });
});
