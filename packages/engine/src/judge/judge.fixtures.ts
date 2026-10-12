import { Secret } from '../credentials/secret.js';
import { jsonResponse } from '../providers/fetch-mock.fixtures.js';

/** A judge key built at runtime, so no secret-looking literal sits in the tests. */
export const judgeKey = (tag = 'j'): string => ['tk', tag, 'q7'.repeat(8)].join('-');
export const judgeSecret = (tag = 'j'): Secret => new Secret(judgeKey(tag));

/** A 200 System One reply giving each question id the noul value in `values`. */
export function noulReply(values: Record<string, number>, usage = { input_tokens: 120, output_tokens: 0 }): Response {
  const answers = Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }]));
  return jsonResponse({ model: 'jev', answers, usage });
}

/** Answers every question of the request body with `value`. */
export function noulForAll(value: number): (url: string, init: RequestInit) => Response {
  return (_url, init) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    return noulReply(Object.fromEntries(Object.keys(body.questions).map((id) => [id, value])));
  };
}

export const noSleep = async (): Promise<void> => undefined;
