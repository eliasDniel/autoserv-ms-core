import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  CambiarEstadoDto,
  GuardarRecepcionDto,
} from './dto/guardar-recepcion.dto';
import { RecepcionService } from './recepcion.service';

@Controller()
export class RecepcionController {
  constructor(private readonly recepcionService: RecepcionService) {}

  @MessagePattern('core.recepcion.listar')
  listar() {
    return this.recepcionService.listar();
  }

  @MessagePattern('core.recepcion.guardar')
  guardar(@Payload() dto: GuardarRecepcionDto) {
    return this.recepcionService.guardar(dto);
  }

  @MessagePattern('core.orden.estado')
  cambiarEstado(@Payload() dto: CambiarEstadoDto) {
    return this.recepcionService.cambiarEstado(dto);
  }
}
