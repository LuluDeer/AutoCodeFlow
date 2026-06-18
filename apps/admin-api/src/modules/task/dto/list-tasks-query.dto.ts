import { IsOptional, IsUUID, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListTasksQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  applicationId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  runtime?: string;

  @IsOptional()
  @IsString()
  triggerType?: string;
}
