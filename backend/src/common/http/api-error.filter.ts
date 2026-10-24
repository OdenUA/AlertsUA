import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json({
        error: {
          code: status,
          message_uk:
            typeof payload === 'object' && payload !== null && 'message' in payload
              ? (payload as { message: string | string[] }).message
              : exception.message,
        },
        request_id: requestId,
        path: request.url,
      });
      return;
    }

    // Не-HTTP исключения (БД, Redis, баги) раньше уходили клиенту как 500
    // без единого следа в серверных логах.
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url} [request_id=${requestId}]: ` +
        (exception instanceof Error
          ? `${exception.message}\n${exception.stack ?? ''}`
          : String(exception)),
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: HttpStatus.INTERNAL_SERVER_ERROR,
        message_uk: 'Сталася внутрішня помилка сервера.',
      },
      request_id: requestId,
      path: request.url,
    });
  }
}
