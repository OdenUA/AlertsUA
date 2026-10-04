import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Header,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { ResolvePointDto } from './dto/resolve-point.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post('resolve-point')
  @Header('Cache-Control', 'public, max-age=60') // 1 minute
  async resolvePoint(@Body() dto: ResolvePointDto) {
    return this.subscriptionsService.resolvePoint(dto.latitude, dto.longitude);
  }

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateSubscriptionDto,
  ) {
    return this.subscriptionsService.create(this.extractToken(authorization), dto);
  }

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query('android_id') androidId?: string,
  ) {
    // Token-first: the installation token identifies the device exactly. The android_id
    // lookup is only a fallback for reinstalled apps whose token is not yet known to the server
    // (installations created before the android_id column existed have NULL there and would
    // otherwise be invisible to their owner while pushes keep flowing).
    const token = this.extractToken(authorization);
    if (token) {
      try {
        return await this.subscriptionsService.list(token, androidId);
      } catch (error) {
        if (!(error instanceof UnauthorizedException)) {
          throw error;
        }
      }
    }
    if (androidId) {
      return this.subscriptionsService.listByAndroidId(androidId);
    }
    return this.subscriptionsService.list(token ?? '');
  }

  @Patch(':subscriptionId')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    return this.subscriptionsService.update(
      this.extractToken(authorization),
      subscriptionId,
      dto,
    );
  }

  @Delete(':subscriptionId')
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    return this.subscriptionsService.remove(this.extractToken(authorization), subscriptionId);
  }

  private extractToken(authorization: string | undefined) {
    return authorization?.replace(/^Bearer\s+/i, '').trim() ?? '';
  }
}
