import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Field, SelectField } from '@/components/shared';
import {
  availableOutputs,
  failurePolicy,
  isFinally,
  sourceChoices,
  uniqueName,
  type FlowStep,
} from './model';
import { Check, JsonField, PairEditor } from './fields';
const choices = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
const operators = choices([
  ['equals', '等于'],
  ['not_equals', '不等于'],
  ['contains', '包含'],
  ['exists', '存在'],
]);
export default function StepEditor({
  step,
  index,
  steps,
  databases,
  services,
  onChange,
  onMove,
  onCopy,
  onDelete,
  onValidityChange,
}: {
  step: FlowStep;
  index: number;
  steps: FlowStep[];
  databases: any[];
  services: any[];
  onChange: (step: FlowStep) => void;
  onMove: (direction: number) => void;
  onCopy: () => void;
  onDelete: () => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [output, setOutput] = useState('');
  const [tab, setTab] = useState('request');
  const update = (patch: Partial<FlowStep>) => onChange({ ...step, ...patch });
  const config = (patch: Partial<FlowStep['config']>) =>
    update({ config: { ...step.config, ...patch } });
  const sources = choices(sourceChoices(step));
  const previousOutputs = availableOutputs(steps, step);
  const insert = (value: string) => {
    if (!value) return;
    setOutput(value);
    navigator.clipboard?.writeText(value).catch(() => {});
  };
  const group = steps.filter((item) => isFinally(item) === isFinally(step));
  const position = group.findIndex((item) => item.id === step.id);
  return (
    <Card className={step.enabled ? '' : 'opacity-60'}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            className="min-w-0 justify-start"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {index + 1}. {step.name || '未命名步骤'}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{step.type.toUpperCase()}</Badge>
            <Check label="启用" value={step.enabled} onChange={(enabled) => update({ enabled })} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!position}
              aria-label={`上移步骤 ${index + 1}`}
              onClick={() => onMove(-1)}
            >
              ↑
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={position === group.length - 1}
              aria-label={`下移步骤 ${index + 1}`}
              onClick={() => onMove(1)}
            >
              ↓
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
              复制步骤
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                config({
                  phase: isFinally(step) ? undefined : 'finally',
                  skip_if_missing_outputs: undefined,
                })
              }
            >
              {isFinally(step) ? '移至执行' : '移至收尾'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
              删除步骤
            </Button>
          </div>
        </div>
        {step.source_status && step.source_status !== 'active' ? (
          <p className="text-xs text-muted-foreground">
            来源接口已归档或删除，本步骤保留独立请求副本。
          </p>
        ) : null}
      </CardHeader>
      <CardContent className={open ? 'space-y-4' : 'hidden'}>
        <Field label="步骤名称">
          <Input
            aria-label={`步骤 ${index + 1} 名称`}
            value={step.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <SelectField
            label="步骤输出引用"
            value=""
            onValueChange={insert}
            options={[
              { value: '', label: '复制前面步骤的输出引用…' },
              ...previousOutputs.map(([value, label]) => ({ value, label })),
            ]}
            disabled={!previousOutputs.length}
          />
          {output ? <code className="select-all text-xs">{output}</code> : null}
          <p className="text-xs text-muted-foreground">
            选择后复制引用，可粘贴到地址、正文、参数或期望值中。
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="request">
              {step.type === 'sql' ? 'SQL 配置' : step.type === 'service' ? '服务配置' : '请求配置'}
            </TabsTrigger>
            {step.type !== 'service' ? (
              <>
                <TabsTrigger value="assertions">断言</TabsTrigger>
                <TabsTrigger value="extractors">响应提取</TabsTrigger>
              </>
            ) : null}
          </TabsList>
          <TabsContent
            forceMount
            hidden={tab !== 'request'}
            value="request"
            className="space-y-4 data-[state=inactive]:hidden"
          >
            {step.type === 'http' ? (
              <>
                <div className="grid gap-3 md:grid-cols-[140px_1fr]">
                  <SelectField
                    label="请求方法"
                    value={step.request.method || 'GET'}
                    onValueChange={(method) => update({ request: { ...step.request, method } })}
                    options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
                      (value) => ({ value, label: value }),
                    )}
                  />
                  <Field label="请求地址">
                    <Input
                      aria-label="请求地址"
                      value={step.request.url || ''}
                      placeholder="https://api.example.com 或 {{base_url}}/path"
                      onChange={(e) =>
                        update({ request: { ...step.request, url: e.target.value } })
                      }
                    />
                  </Field>
                </div>
                <PairEditor
                  label="查询参数"
                  value={step.request.query_params || []}
                  onChange={(query_params) =>
                    update({ request: { ...step.request, query_params } })
                  }
                />
                <PairEditor
                  label="请求头"
                  value={step.request.headers || []}
                  onChange={(headers) => update({ request: { ...step.request, headers } })}
                />
                <SelectField
                  label="正文类型"
                  value={step.request.body_type || 'none'}
                  onValueChange={(body_type) => update({ request: { ...step.request, body_type } })}
                  options={choices([
                    ['none', '无正文'],
                    ['json', 'JSON'],
                    ['text', '文本'],
                    ['form', 'Form URL Encoded'],
                  ])}
                />
                {step.request.body_type !== 'none' ? (
                  <Field label="请求正文">
                    <Textarea
                      aria-label="请求正文"
                      className="font-mono"
                      rows={6}
                      value={step.request.body || ''}
                      onChange={(e) =>
                        update({ request: { ...step.request, body: e.target.value } })
                      }
                    />
                  </Field>
                ) : null}
              </>
            ) : null}
            {step.type === 'sql' && step.sql ? (
              <>
                <SelectField
                  label="数据库连接"
                  value={step.sql.connection_id}
                  onValueChange={(connection_id) =>
                    update({ sql: { ...step.sql!, connection_id } })
                  }
                  options={[
                    { value: '', label: '请选择已配置的连接' },
                    ...databases.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.type || 'mysql'}`,
                    })),
                  ]}
                />
                <SelectField
                  label="SQL 操作类型"
                  value={step.sql.mode}
                  onValueChange={(mode) =>
                    update({
                      sql: { ...step.sql!, mode },
                      config: {
                        ...step.config,
                        expected_rows: undefined,
                        assertions: [],
                        extractors: [],
                      },
                    })
                  }
                  options={choices([
                    ['query', '查询'],
                    ['exec', '执行语句'],
                  ])}
                />
                <Field
                  label="SQL 语句"
                  description="MySQL 使用 ?，PostgreSQL / Hologres 使用 $1、$2，步骤输出通过绑定参数传入。"
                >
                  <Textarea
                    aria-label="SQL 语句"
                    rows={5}
                    className="font-mono"
                    value={step.sql.sql}
                    onChange={(e) => update({ sql: { ...step.sql!, sql: e.target.value } })}
                  />
                </Field>
                <JsonField
                  label="SQL 参数"
                  value={step.sql.params || []}
                  onChange={(params) => update({ sql: { ...step.sql!, params } })}
                  onValidityChange={onValidityChange}
                />
                <Field label="最大返回行数">
                  <Input
                    aria-label="最大返回行数"
                    type="number"
                    min={1}
                    max={10000}
                    value={step.sql.max_rows}
                    onChange={(e) =>
                      update({ sql: { ...step.sql!, max_rows: Number(e.target.value) } })
                    }
                  />
                </Field>
              </>
            ) : null}
            {step.type === 'service' && step.service ? (
              <>
                <SelectField
                  label="本地服务"
                  value={step.service.service_id}
                  onValueChange={(service_id) =>
                    update({ service: { ...step.service!, service_id } })
                  }
                  options={[
                    { value: '', label: '请选择已配置的服务' },
                    ...services.map((item) => ({ value: item.id, label: item.name })),
                  ]}
                />
                <SelectField
                  label="服务操作"
                  value={step.service.action}
                  onValueChange={(action) => update({ service: { ...step.service!, action } })}
                  options={choices([
                    ['start', '启动或复用服务'],
                    ['stop', '停止本流程启动的服务'],
                  ])}
                />
                <p className="text-sm text-muted-foreground">
                  优先复用健康服务；流程结束后清理本次流程启动的服务。
                </p>
              </>
            ) : null}
          </TabsContent>
          <TabsContent
            forceMount
            hidden={tab !== 'assertions'}
            value="assertions"
            className="space-y-4 data-[state=inactive]:hidden"
          >
            {step.type === 'http' || step.sql?.mode === 'query' ? (
              <Field label={step.type === 'sql' ? '期望行数（可留空）' : '期望状态码（可留空）'}>
                <Input
                  aria-label={step.type === 'sql' ? '期望行数' : '期望状态码'}
                  type="number"
                  min={step.type === 'sql' ? 0 : 100}
                  max={step.type === 'sql' ? undefined : 599}
                  value={
                    (step.type === 'sql'
                      ? step.config.expected_rows
                      : step.config.expected_status) ?? ''
                  }
                  onChange={(e) =>
                    config({
                      [step.type === 'sql' ? 'expected_rows' : 'expected_status']:
                        e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                />
              </Field>
            ) : null}
            {(step.config.assertions || []).map((rule, i) => (
              <div className="space-y-3 rounded-md border p-3" key={i}>
                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField
                    label={`断言 ${i + 1} 来源`}
                    value={rule.source}
                    options={sources}
                    onValueChange={(source) =>
                      config({
                        assertions: step.config.assertions.map((item, j) =>
                          j === i ? { ...item, source, path: '' } : item,
                        ),
                      })
                    }
                  />
                  {['body', 'header', 'rows'].includes(rule.source) ? (
                    <Field label={`断言 ${i + 1} 路径`}>
                      <Input
                        aria-label={`断言 ${i + 1} 路径`}
                        value={rule.path || ''}
                        onChange={(e) =>
                          config({
                            assertions: step.config.assertions.map((item, j) =>
                              j === i ? { ...item, path: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Field>
                  ) : null}
                  <SelectField
                    label={`断言 ${i + 1} 条件`}
                    value={rule.operator}
                    options={operators}
                    onValueChange={(operator) =>
                      config({
                        assertions: step.config.assertions.map((item, j) =>
                          j === i ? { ...item, operator } : item,
                        ),
                      })
                    }
                  />
                  {rule.operator !== 'exists' ? (
                    <Field label={`断言 ${i + 1} 期望值`}>
                      <Input
                        aria-label={`断言 ${i + 1} 期望值`}
                        value={rule.expected || ''}
                        onChange={(e) =>
                          config({
                            assertions: step.config.assertions.map((item, j) =>
                              j === i ? { ...item, expected: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Field>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    config({ assertions: step.config.assertions.filter((_, j) => j !== i) })
                  }
                >
                  移除断言
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                config({
                  assertions: [
                    ...(step.config.assertions || []),
                    { source: sources[0].value, path: '', operator: 'exists', expected: '' },
                  ],
                })
              }
            >
              添加响应断言
            </Button>
          </TabsContent>
          <TabsContent
            forceMount
            hidden={tab !== 'extractors'}
            value="extractors"
            className="space-y-4 data-[state=inactive]:hidden"
          >
            {(step.config.extractors || []).map((rule, i) => (
              <div className="space-y-3 rounded-md border p-3" key={i}>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={`提取 ${i + 1} 变量名`}>
                    <Input
                      aria-label={`提取 ${i + 1} 变量名`}
                      value={rule.name}
                      onChange={(e) =>
                        config({
                          extractors: step.config.extractors.map((item, j) =>
                            j === i ? { ...item, name: e.target.value } : item,
                          ),
                        })
                      }
                    />
                  </Field>
                  <SelectField
                    label={`提取 ${i + 1} 来源`}
                    value={rule.source}
                    options={sources}
                    onValueChange={(source) =>
                      config({
                        extractors: step.config.extractors.map((item, j) =>
                          j === i ? { ...item, source, path: '' } : item,
                        ),
                      })
                    }
                  />
                  {['body', 'header', 'rows'].includes(rule.source) ? (
                    <Field label={`提取 ${i + 1} 路径`}>
                      <Input
                        aria-label={`提取 ${i + 1} 路径`}
                        value={rule.path || ''}
                        onChange={(e) =>
                          config({
                            extractors: step.config.extractors.map((item, j) =>
                              j === i ? { ...item, path: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Field>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-3">
                  <Check
                    label="必须提取成功"
                    value={!!rule.required}
                    onChange={(required) =>
                      config({
                        extractors: step.config.extractors.map((item, j) =>
                          j === i ? { ...item, required } : item,
                        ),
                      })
                    }
                  />
                  <Check
                    label="敏感值"
                    value={!!rule.secret}
                    onChange={(secret) =>
                      config({
                        extractors: step.config.extractors.map((item, j) =>
                          j === i ? { ...item, secret } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      config({ extractors: step.config.extractors.filter((_, j) => j !== i) })
                    }
                  >
                    移除提取
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                config({
                  extractors: [
                    ...(step.config.extractors || []),
                    {
                      name: uniqueName(step.config.extractors || [], 'value'),
                      source: sources[0].value,
                      path: '',
                      scope: 'run',
                      required: true,
                      secret: false,
                    },
                  ],
                })
              }
            >
              添加提取规则
            </Button>
          </TabsContent>
        </Tabs>
        {isFinally(step) ? (
          <>
            <p className="text-sm text-muted-foreground">
              收尾失败会单独记录，并继续其他收尾步骤。
            </p>
            <Check
              label="引用的步骤输出不存在时跳过"
              value={!!step.config.skip_if_missing_outputs}
              onChange={(skip_if_missing_outputs) => config({ skip_if_missing_outputs })}
            />
          </>
        ) : (
          <SelectField
            label={`步骤 ${index + 1} 失败策略`}
            value={failurePolicy(step)}
            options={choices([
              ['inherit', '遵循流程设置'],
              ['stop', '停止后续步骤'],
              ['continue', '继续后续步骤'],
            ])}
            onValueChange={(value) =>
              config({
                failure_policy: value === 'inherit' ? undefined : value,
                continue_on_error: false,
              })
            }
          />
        )}
        <Field label="步骤超时（秒，可留空继承）">
          <Input
            aria-label={`步骤 ${index + 1} 超时`}
            type="number"
            min={1}
            max={300}
            value={step.config.timeout_ms ? step.config.timeout_ms / 1000 : ''}
            onChange={(e) =>
              config({ timeout_ms: e.target.value ? Number(e.target.value) * 1000 : undefined })
            }
          />
        </Field>
      </CardContent>
    </Card>
  );
}
