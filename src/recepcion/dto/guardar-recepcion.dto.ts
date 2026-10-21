import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ClienteInput {
  @IsOptional()
  @IsInt()
  id?: number;

  @IsString()
  @MinLength(2)
  nombre: string;

  @IsOptional()
  @IsString()
  telefono?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  direccion?: string;

  @IsOptional()
  @IsString()
  ciudad?: string;
}

export class VehiculoInput {
  @IsOptional()
  @IsInt()
  id?: number;

  @IsString()
  @MinLength(3)
  placa: string;

  @IsString()
  marca: string;

  @IsString()
  modelo: string;

  @IsInt()
  anio: number;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  vin?: string;

  @IsOptional()
  @IsString()
  motor?: string;

  @IsOptional()
  @IsString()
  combustible?: string;

  @IsOptional()
  @IsString()
  transmision?: string;

  @IsInt()
  @Min(0)
  kilometraje: number;
}

export class ParteInput {
  @IsString()
  zona: string;

  @IsBoolean()
  ok: boolean;
}

export class ServicioInput {
  @IsString()
  codigo: string;

  @IsString()
  nombre: string;

  @IsString()
  tiempo: string;

  @IsNumber()
  precio: number;
}

export class RepuestoInput {
  @IsString()
  codigo: string;

  @IsString()
  nombre: string;

  @IsInt()
  @Min(1)
  cantidad: number;

  @IsNumber()
  precio: number;

  @IsBoolean()
  usado: boolean;
}

export class GuardarRecepcionDto {
  @IsOptional()
  @IsString()
  numeroOs?: string;

  @IsInt()
  idAsesor: number;

  @IsString()
  nombreAsesor: string;

  @ValidateNested()
  @Type(() => ClienteInput)
  cliente: ClienteInput;

  @ValidateNested()
  @Type(() => VehiculoInput)
  vehiculo: VehiculoInput;

  @IsInt()
  @Min(0)
  nivelCombustible: number;

  @IsBoolean()
  tieneLlaves: boolean;

  @IsBoolean()
  tieneAlarma: boolean;

  @IsBoolean()
  autorizacionFirmada: boolean;

  @IsBoolean()
  garantiaVigente: boolean;

  @IsOptional()
  @IsString()
  tipoGarantia?: string;

  @IsOptional()
  @IsString()
  numeroGarantia?: string;

  @IsOptional()
  @IsString()
  observacionesCliente?: string;

  @IsOptional()
  @IsString()
  notasTecnico?: string;

  @IsOptional()
  @IsString()
  notasInspeccion?: string;

  @IsOptional()
  @IsString()
  firmaDigital?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParteInput)
  partes: ParteInput[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServicioInput)
  servicios: ServicioInput[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RepuestoInput)
  repuestos: RepuestoInput[];
}

export class CambiarEstadoDto {
  @IsString()
  numeroOs: string;

  @IsString()
  estado: 'recepcion' | 'en_taller' | 'terminada';

  @IsInt()
  idUsuario: number;
}
