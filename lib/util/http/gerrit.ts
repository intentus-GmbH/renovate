import JSON5 from 'json5';
import { ZodSchema } from 'zod';
import { PlatformId } from '../../constants';
import type { HttpOptions, HttpResponse, InternalHttpOptions } from './types';
import { Http } from './index';

let baseUrl: string;
export const setBaseUrl = (url: string): void => {
  baseUrl = url;
};

/**
 * Access Gerrit REST-API and strip-of the "magic prefix" from responses.
 * @see https://gerrit-review.googlesource.com/Documentation/rest-api.html
 */
export class GerritHttp extends Http {
  constructor(options?: HttpOptions) {
    super(PlatformId.Gerrit, options);
  }

  protected override request<T>(
    path: string,
    options?: InternalHttpOptions
  ): Promise<HttpResponse<T>> {
    const url = baseUrl + path;
    const opts = {
      baseUrl,
      ...options,
    };
    opts.headers = {
      ...opts.headers,
    };
    return super.request<T>(url, opts);
  }

  override get(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
    return super
      .get(url, options)
      .then((res) => ({ ...res, body: res.body.replaceAll(/^\)]}'/g, '') }));
  }

  override getJson<T = any>(
    url: string,
    options?: HttpOptions | ZodSchema,
    arg3?: ZodSchema
  ): Promise<HttpResponse<T>> {
    return super
      .get(url, options instanceof ZodSchema ? undefined : options)
      .then((res) => ({
        ...res,
        body: JSON5.parse(res.body.replaceAll(/^\)]}'/g, '')),
      }));
  }

  //TODO: ugly and broken for ZodSchema usage
  override async postJson<T = unknown>(
    url: string,
    options?: HttpOptions | ZodSchema
  ): Promise<HttpResponse<T>> {
    const body =
      options instanceof ZodSchema ? undefined : JSON5.stringify(options?.body);
    const res = await this.request<string>(url, {
      ...options,
      method: 'post',
      body,
      headers: {
        ...(body && { 'Content-Type': 'application/json' }),
      },
    });
    return {
      ...res,
      body: JSON5.parse(res.body.replaceAll(/^\)]}'/g, '')),
    };
  }
}
