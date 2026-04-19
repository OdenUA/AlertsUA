import { IsString } from 'class-validator';

export class UpdatePushTokenDto {
  @IsString()
  fcm_token!: string;
}
