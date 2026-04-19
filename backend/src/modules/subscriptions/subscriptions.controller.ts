import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { ResolvePointDto } from './dto/resolve-point.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post('resolve-point')
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
  async list(@Headers('authorization') authorization: string | undefined) {
    return this.subscriptionsService.list(this.extractToken(authorization));
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
