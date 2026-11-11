export class GuardarServicioDto {
  codigo?: string;
  nombre: string;
  tiempo: string;
  precio: number;
}

export class ServicioCsvFilaDto {
  codigo: string;
  nombre: string;
  tiempo: string;
  precio: number;
}

export class ImportarServiciosDto {
  filas: ServicioCsvFilaDto[];
}
