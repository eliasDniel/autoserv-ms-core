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
    sincronizarStock?: boolean;
  }) {
    return this.recepcionService.crearRepuesto(dto);
  }

  @MessagePattern('core.inventario.eliminar')
  eliminarRepuesto(@Payload() dto: { codigo: string }) {
    return this.recepcionService.eliminarRepuesto(dto.codigo);
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

  @MessagePattern('core.cita.horasLibres')
  horasLibres(@Payload() dto: { fecha: string; servicioId?: number }) {
    return this.recepcionService.horasLibres(dto);
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
    origen?: string;
    telegramChatId?: string;
    clienteId?: number;
    vehiculoId?: number;
    servicioId?: number;
  }) {
    return this.recepcionService.guardarCita(dto);
  }

  @MessagePattern('core.cliente.vincularTelegram')
  vincularTelegram(@Payload() dto: {
    token?: string;
    telefono?: string;
    cedula?: string;
    chatId: string;
    nombre?: string;
  }) {
    return this.recepcionService.vincularTelegram(dto);
  }

  @MessagePattern('core.cliente.crearVinculoTelegram')
  crearVinculoTelegram(@Payload() dto: { clienteId: number }) {
    return this.recepcionService.crearVinculoTelegram(dto);
  }

  @MessagePattern('core.cliente.porChat')
  clientePorChat(@Payload() dto: { chatId: string }) {
    return this.recepcionService.clientePorChat(dto);
  }

  @MessagePattern('core.cliente.guardar')
  guardarCliente(@Payload() dto: {
    id?: number | string;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    city?: string;
    cedula?: string;
  }) {
    return this.recepcionService.guardarCliente(dto);
  }

  @MessagePattern('core.cliente.eliminar')
  eliminarCliente(@Payload() dto: { id: number | string }) {
    return this.recepcionService.eliminarCliente(dto.id);
  }

  @MessagePattern('core.vehiculo.guardar')
  guardarVehiculo(@Payload() dto: {
    id?: number | string;
    clientId: number | string;
    plate: string;
    brand: string;
    model: string;
    year?: string | number;
    color?: string;
    vin?: string;
    engine?: string;
    fuel?: string;
    transmission?: string;
    km?: number;
  }) {
    return this.recepcionService.guardarVehiculo(dto);
  }

  @MessagePattern('core.vehiculo.eliminar')
  eliminarVehiculo(@Payload() dto: { id: number | string }) {
    return this.recepcionService.eliminarVehiculo(dto.id);
  }

  @MessagePattern('core.cita.porChat')
  citasPorChat(@Payload() dto: { chatId: string }) {
    return this.recepcionService.citasPorChat(dto);
  }

  @MessagePattern('core.cita.cancelarTelegram')
  cancelarCitaTelegram(@Payload() dto: { id: number; chatId: string }) {
    return this.recepcionService.cancelarCitaTelegram(dto);
  }

  @MessagePattern('core.cita.confirmarTelegram')
  confirmarCitaTelegram(@Payload() dto: { id: number; chatId: string }) {
    return this.recepcionService.confirmarCitaTelegram(dto);
  }

  @MessagePattern('core.cita.recordatorios')
  citasParaRecordatorio(@Payload() dto: { ventana: '24h' | '2h' }) {
    return this.recepcionService.citasParaRecordatorio(dto);
  }

  @MessagePattern('core.cita.marcarRecordatorio')
  marcarRecordatorio(@Payload() dto: { id: number; ventana: '24h' | '2h' }) {
    return this.recepcionService.marcarRecordatorio(dto);
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
