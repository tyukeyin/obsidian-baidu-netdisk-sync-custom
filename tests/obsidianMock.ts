import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
export class TFile {}
let handler: ((param: RequestUrlParam) => Promise<RequestUrlResponse>) | undefined;
export function setRequestHandler(value: typeof handler): void { handler = value; }
export function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  if (!handler) throw new Error('Network forbidden in offline tests');
  return handler(param);
}