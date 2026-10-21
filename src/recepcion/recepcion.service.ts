import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { EstadoOrden, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CambiarEstadoDto,
  GuardarRecepcionDto,
} from './dto/guardar-recepcion.dto';

const ZONAS = [
  'Parabrisas',
  'Espejo Izq.',
  'Faro Izq.',
  'Llanta Del. Izq.',
  'Puerta Izq.',
  'Puerta Tras. Izq.',
  'Parabrisas Tras.',
  'Espejo Der.',
  'Faro Der.',
  'Llanta Del. Der.',
  'Puerta Der.',
  'Puerta Tras. Der.',
  'Parachoques Tras.',
];

const ordenInclude = {
  vehiculo: { include: { cliente: true } },
  inspecciones: true,
  servicios: { include: { servicio: true } },
  repuestos: { include: { repuesto: true } },
} satisfies Prisma.OrdenServicioInclude;

type OrdenCompleta = Prisma.OrdenServicioGetPayload<{
  include: typeof ordenInclude;
}>;

type Tx = Prisma.TransactionClient;

@Injectable()
export class RecepcionService {
  constructor(private readonly prisma: PrismaService) {}

  async listar() {
    const ordenes = await this.prisma.ordenServicio.findMany({
      include: ordenInclude,
      orderBy: { fechaIngreso: 'desc' },
    });
    const bundles = ordenes.map((orden) => this.presentar(orden));
    const clientes = new Map(bundles.map((item) => [item.cliente.id, item.cliente]));
    const vehiculos = new Map(
      bundles.map((item) => [item.vehiculo.id, item.vehiculo]),
    );
    return {
      clientes: [...clientes.values()],
      vehiculos: [...vehiculos.values()],
      ordenes: bundles.map((item) => item.orden),
    };
  }

  async guardar(dto: GuardarRecepcionDto) {
    const guardada = await this.prisma.$transaction(async (tx) => {
      const cliente = await this.upsertCliente(tx, dto);
      const vehiculo = await this.upsertVehiculo(tx, dto, cliente.id);
      const orden = await this.upsertOrden(tx, dto, vehiculo.id);
      await this.reemplazarInspeccion(tx, orden.id, dto);
      await this.reemplazarServicios(tx, orden.id, dto.servicios);
      await this.reemplazarRepuestos(tx, orden.id, dto);
      return tx.ordenServicio.findUniqueOrThrow({
        where: { id: orden.id },
        include: ordenInclude,
      });
    });
    return this.presentar(guardada);
  }

  async cambiarEstado(dto: CambiarEstadoDto) {
    if (!['recepcion', 'en_taller', 'terminada'].includes(dto.estado)) {
      throw new RpcException({
        statusCode: 400,
        message: 'Estado de la orden no válido',
      });
    }

    const actualizada = await this.prisma.$transaction(async (tx) => {
      const orden = await tx.ordenServicio.findUnique({
        where: { numeroOs: dto.numeroOs },
      });
      if (!orden) {
        throw new RpcException({
          statusCode: 404,
          message: 'La orden no existe',
        });
      }
      if (orden.estado !== dto.estado) {
        await tx.historialEstadoOrden.create({
          data: {
            ordenId: orden.id,
            idUsuario: dto.idUsuario,
            estadoAnterior: orden.estado,
            estadoNuevo: dto.estado,
          },
        });
        await tx.ordenServicio.update({
          where: { id: orden.id },
          data: {
            estado: dto.estado as EstadoOrden,
            fechaFinalizacion:
              dto.estado === 'terminada' ? new Date() : orden.fechaFinalizacion,
          },
        });
      }
      return tx.ordenServicio.findUniqueOrThrow({
        where: { id: orden.id },
        include: ordenInclude,
      });
    });

    return this.presentar(actualizada).orden;
  }

  private async upsertCliente(tx: Tx, dto: GuardarRecepcionDto) {
    const data = {
      nombre: dto.cliente.nombre.trim(),
      telefono: vacio(dto.cliente.telefono),
      email: vacio(dto.cliente.email),
      direccion: vacio(dto.cliente.direccion),
      ciudad: vacio(dto.cliente.ciudad),
    };
    if (dto.cliente.id) {
      return tx.cliente.update({ where: { id: dto.cliente.id }, data });
    }
    if (dto.vehiculo.id) {
      const vehiculo = await tx.vehiculo.findUnique({
        where: { id: dto.vehiculo.id },
      });
      if (vehiculo) {
        return tx.cliente.update({ where: { id: vehiculo.clienteId }, data });
      }
    }
    const porPlaca = await tx.vehiculo.findUnique({
      where: { placa: dto.vehiculo.placa.trim().toUpperCase() },
    });
    if (porPlaca) {
      return tx.cliente.update({ where: { id: porPlaca.clienteId }, data });
    }
    return tx.cliente.create({ data });
  }

  private async upsertVehiculo(tx: Tx, dto: GuardarRecepcionDto, clienteId: number) {
    const data = {
      clienteId,
      placa: dto.vehiculo.placa.trim().toUpperCase(),
      marca: dto.vehiculo.marca.trim(),
      modelo: dto.vehiculo.modelo.trim(),
      anio: dto.vehiculo.anio,
      color: vacio(dto.vehiculo.color),
      vin: vacio(dto.vehiculo.vin),
      motor: vacio(dto.vehiculo.motor),
      combustible: vacio(dto.vehiculo.combustible),
      transmision: vacio(dto.vehiculo.transmision),
      kilometraje: dto.vehiculo.kilometraje,
    };
    const existente = dto.vehiculo.id
      ? await tx.vehiculo.findUnique({ where: { id: dto.vehiculo.id } })
      : await tx.vehiculo.findUnique({ where: { placa: data.placa } });
    if (existente) {
      return tx.vehiculo.update({ where: { id: existente.id }, data });
    }
    return tx.vehiculo.create({ data });
  }

  private async upsertOrden(tx: Tx, dto: GuardarRecepcionDto, vehiculoId: number) {
    const firma = vacio(dto.firmaDigital);
    const data = {
      vehiculoId,
      nombreAsesor: dto.nombreAsesor,
      kilometrajeIngreso: dto.vehiculo.kilometraje,
      nivelCombustible: dto.nivelCombustible,
      tieneLlaves: dto.tieneLlaves,
      tieneAlarma: dto.tieneAlarma,
      firmaDigital: firma,
      fechaFirma: firma ? new Date() : null,
      observacionesCliente: vacio(dto.observacionesCliente),
      notasTecnico: vacio(dto.notasTecnico),
      notasInspeccion: vacio(dto.notasInspeccion),
      autorizacionFirmada: dto.autorizacionFirmada || Boolean(firma),
      garantiaVigente: dto.garantiaVigente,
      tipoGarantia: vacio(dto.tipoGarantia),
      numeroGarantia: vacio(dto.numeroGarantia),
    };
    const existente = dto.numeroOs
      ? await tx.ordenServicio.findUnique({ where: { numeroOs: dto.numeroOs } })
      : null;
    if (existente) {
      return tx.ordenServicio.update({ where: { id: existente.id }, data });
    }
    const creada = await tx.ordenServicio.create({
      data: {
        ...data,
        numeroOs: await this.siguienteNumero(tx),
        idAsesor: dto.idAsesor,
      },
    });
    await tx.historialEstadoOrden.create({
      data: {
        ordenId: creada.id,
        idUsuario: dto.idAsesor,
        estadoAnterior: null,
        estadoNuevo: 'recepcion',
      },
    });
    return creada;
  }

  private async siguienteNumero(tx: Tx) {
    const year = new Date().getFullYear();
    const prefix = `OS-${year}-`;
    const ultima = await tx.ordenServicio.findFirst({
      where: { numeroOs: { startsWith: prefix } },
      orderBy: { numeroOs: 'desc' },
    });
    const correlativo = ultima
      ? Number(ultima.numeroOs.slice(prefix.length)) + 1
      : 1;
    return `${prefix}${String(correlativo).padStart(6, '0')}`;
  }

  private async reemplazarInspeccion(tx: Tx, ordenId: number, dto: GuardarRecepcionDto) {
    await tx.inspeccionDanio.deleteMany({ where: { ordenId } });
    const danos = dto.partes.filter((parte) => !parte.ok);
    if (danos.length === 0) return;
    await tx.inspeccionDanio.createMany({
      data: danos.map((parte) => ({
        ordenId,
        zona: parte.zona,
        tipoDanio: 'visual',
        severidad: 'media',
        descripcion: vacio(dto.notasInspeccion),
      })),
    });
  }

  private async reemplazarServicios(
    tx: Tx,
    ordenId: number,
    servicios: GuardarRecepcionDto['servicios'],
  ) {
    await tx.ordenServicioServicio.deleteMany({ where: { ordenId } });
    for (const linea of servicios) {
      const servicio = await tx.servicio.upsert({
        where: { codigo: linea.codigo },
        update: {
          nombre: linea.nombre,
          precio: linea.precio,
          tiempoEstimadoMin: minutos(linea.tiempo),
        },
        create: {
          codigo: linea.codigo,
          nombre: linea.nombre,
          precio: linea.precio,
          tiempoEstimadoMin: minutos(linea.tiempo),
        },
      });
      await tx.ordenServicioServicio.create({
        data: {
          ordenId,
          servicioId: servicio.id,
          precioServicio: linea.precio,
          tiempoEtiqueta: linea.tiempo,
        },
      });
    }
  }

  private async reemplazarRepuestos(tx: Tx, ordenId: number, dto: GuardarRecepcionDto) {
    await tx.detalleRepuestoOrden.deleteMany({ where: { ordenId } });
    for (const linea of dto.repuestos) {
      const repuesto = await tx.repuesto.upsert({
        where: { codigo: linea.codigo },
        update: { nombre: linea.nombre, precioUnitario: linea.precio },
        create: {
          codigo: linea.codigo,
          nombre: linea.nombre,
          precioUnitario: linea.precio,
        },
      });
      await tx.detalleRepuestoOrden.create({
        data: {
          ordenId,
          repuestoId: repuesto.id,
          idUsuario: dto.idAsesor,
          cantidad: linea.cantidad,
          precioUnitario: linea.precio,
          usado: linea.usado,
        },
      });
    }
  }

  private presentar(orden: OrdenCompleta) {
    const danos = new Set(orden.inspecciones.map((item) => item.zona));
    const partes = Object.fromEntries(ZONAS.map((zona) => [zona, !danos.has(zona)]));
    const cliente = orden.vehiculo.cliente;
    return {
      cliente: {
        id: String(cliente.id),
        name: cliente.nombre,
        phone: cliente.telefono ?? '',
        email: cliente.email ?? '',
        address: cliente.direccion ?? '',
        city: cliente.ciudad ?? '',
      },
      vehiculo: {
        id: String(orden.vehiculo.id),
        clientId: String(cliente.id),
        plate: orden.vehiculo.placa,
        brand: orden.vehiculo.marca,
        model: orden.vehiculo.modelo,
        year: String(orden.vehiculo.anio),
        color: orden.vehiculo.color ?? '',
        vin: orden.vehiculo.vin ?? '',
        engine: orden.vehiculo.motor ?? '',
        fuel: orden.vehiculo.combustible ?? '',
        transmission: orden.vehiculo.transmision ?? '',
        km: orden.vehiculo.kilometraje,
      },
      orden: {
        os: orden.numeroOs,
        clientId: String(cliente.id),
        vehicleId: String(orden.vehiculo.id),
        advisor: orden.nombreAsesor,
        date: orden.fechaIngreso.toLocaleDateString('es-EC', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          timeZone: 'America/Guayaquil',
        }),
        status: orden.estado,
        fuelLevel: orden.nivelCombustible,
        hasKey: orden.tieneLlaves,
        hasAlarm: orden.tieneAlarma,
        authSigned: orden.autorizacionFirmada,
        warranty: orden.garantiaVigente,
        warrantyType: orden.tipoGarantia ?? '',
        warrantyNum: orden.numeroGarantia ?? '',
        clientObservations: orden.observacionesCliente ?? '',
        techNotes: orden.notasTecnico ?? '',
        inspectionNotes: orden.notasInspeccion ?? '',
        parts: partes,
        services: orden.servicios.map((linea) => ({
          code: linea.servicio.codigo,
          name: linea.servicio.nombre,
          time: linea.tiempoEtiqueta,
          price: Number(linea.precioServicio),
        })),
        usedParts: orden.repuestos.map((linea) => ({
          code: linea.repuesto.codigo,
          name: linea.repuesto.nombre,
          qty: linea.cantidad,
          price: Number(linea.precioUnitario),
          used: linea.usado,
        })),
        signature: orden.firmaDigital ?? undefined,
      },
    };
  }
}

function vacio(valor?: string | null) {
  const limpio = valor?.trim();
  return limpio ? limpio : null;
}

function minutos(tiempo: string) {
  const horas = Number.parseFloat(tiempo);
  if (Number.isNaN(horas)) return 60;
  return Math.round(horas * 60);
}
