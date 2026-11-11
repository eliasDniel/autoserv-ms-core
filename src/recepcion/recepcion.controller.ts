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

  @MessagePattern('core.datos.reiniciar')
  reiniciar() {
    return this.recepcionService.reiniciar();
  }

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

  @MessagePattern('core.orden.eliminar')
  eliminar(@Payload() dto: { numeroOs: string }) {
    return this.recepcionService.eliminar(dto.numeroOs);
  }

  @MessagePattern('core.inventario.listar')
  listarInventario() {
    return this.recepcionService.listarInventario();
  }

  @MessagePattern('core.inventario.mover')
  moverInventario(@Payload() dto: { codigo: string; tipo: string; cantidad: number; nota?: string }) {
    return this.recepcionService.moverInventario(dto);
  }

  @MessagePattern('core.inventario.crear')
  crearRepuesto(@Payload() dto: {
    codigo?: string;
    nombre: string;
    categoria?: string;
    stock?: number;
    min?: number;
    max?: number;
    precio?: number;
  }) {
    return this.recepcionService.crearRepuesto(dto);
  }

  @MessagePattern('core.inventario.importar')
  importarRepuestos(@Payload() dto: {
    filas: {
      codigo: string;
      nombre: string;
      categoria?: string;
      stock?: number;
      min?: number;
      max?: number;
      precio?: number;
    }[];
  }) {
    return this.recepcionService.importarRepuestos(dto.filas ?? []);
  }

  @MessagePattern('core.cita.listar')
  listarCitas() {
    return this.recepcionService.listarCitas();
  }

  @MessagePattern('core.cita.guardar')
  guardarCita(@Payload() dto: {
    id?: number;
    nombreCliente: string;
    telefono?: string;
    placa?: string;
    servicio: string;
    fecha: string;
    hora: string;
    mecanico: string;
    notas?: string;
    estado?: string;
  }) {
    return this.recepcionService.guardarCita(dto);
  }

  @MessagePattern('core.servicios.listar')
  listarServicios() {
    return this.recepcionService.listarServicios();
  }

  @MessagePattern('core.servicios.guardar')
  guardarServicio(@Payload() dto: {
    codigo?: string;
    nombre: string;
    tiempo: string;
    precio: number;
  }) {
    return this.recepcionService.guardarServicio(dto);
  }

  @MessagePattern('core.servicios.eliminar')
  eliminarServicio(@Payload() dto: { codigo: string }) {
    return this.recepcionService.eliminarServicio(dto.codigo);
  }

  @MessagePattern('core.servicios.importar')
  importarServicios(@Payload() dto: {
    filas: { codigo: string; nombre: string; tiempo: string; precio: number }[];
  }) {
    return this.recepcionService.importarServicios(dto.filas ?? []);
  }
}
