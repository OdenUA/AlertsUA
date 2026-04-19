import {
  Body,
  Controller,
  Headers,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { RegisterInstallationDto } from './dto/register-installation.dto';
import { UpdateInstallationDto } from './dto/update-installation.dto';
import { UpdatePushTokenDto } from './dto/update-push-token.dto';
import { InstallationsService } from './installations.service';

@Controller('installations')
export class InstallationsController {
  constructor(private readonly installationsService: InstallationsService) {}

  @Post()
  async register(@Body() dto: RegisterInstallationDto) {
    return this.installationsService.register(dto);
  }

  @Patch('me')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdateInstallationDto,
  ) {
    return this.installationsService.update(this.extractToken(authorization), dto);
  }

  @Put('me/push-token')
  async updatePushToken(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdatePushTokenDto,
  ) {
    return this.installationsService.updatePushToken(
      this.extractToken(authorization),
      dto.fcm_token,
    );
  }

  private extractToken(authorization: string | undefined) {
    return authorization?.replace(/^Bearer\s+/i, '').trim() ?? '';
  }
}
