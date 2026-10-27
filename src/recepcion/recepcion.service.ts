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

const CATALOGO = [
  { codigo: 'REP-001', nombre: 'Aceite Motor 5W-30 (1L)', categoria: 'Lubricantes', precio: 8.5, stock: 42, min: 20, max: 100, rotacion: 'Alta' },
  { codigo: 'REP-002', nombre: 'Filtro de Aceite Chevrolet', categoria: 'Filtros', precio: 12, stock: 8, min: 10, max: 40, rotacion: 'Alta' },
  { codigo: 'REP-003', nombre: 'Pastillas de Freno Delanteras', categoria: 'Frenos', precio: 45, stock: 3, min: 5, max: 20, rotacion: 'Media' },
  { codigo: 'REP-004', nombre: 'Bujías NGK (juego)', categoria: 'Encendido', precio: 28, stock: 15, min: 8, max: 30, rotacion: 'Media' },
  { codigo: 'REP-005', nombre: 'Refrigerante 50/50 (1L)', categoria: 'Lubricantes', precio: 6.5, stock: 2, min: 10, max: 30, rotacion: 'Alta' },
  { codigo: 'REP-006', nombre: 'Correa de Distribución', categoria: 'Motor', precio: 85, stock: 4, min: 3, max: 10, rotacion: 'Baja' },
  { codigo: 'REP-007', nombre: 'Amortiguador Delantero Der.', categoria: 'Suspensión', precio: 120, stock: 1, min: 2, max: 8, rotacion: 'Baja' },
  { codigo: 'REP-008', nombre: 'Filtro de Aire', categoria: 'Filtros', precio: 18, stock: 18, min: 8, max: 35, rotacion: 'Alta' },
  { codigo: 'REP-009', nombre: 'Aceite de Transmisión ATF', categoria: 'Lubricantes', precio: 15, stock: 12, min: 6, max: 24, rotacion: 'Media' },
  { codigo: 'REP-010', nombre: 'Líquido de Frenos DOT 4', categoria: 'Frenos', precio: 9, stock: 7, min: 4, max: 16, rotacion: 'Media' },
] as const;

const ROTACION = Object.fromEntries(CATALOGO.map((item) => [item.codigo, item.rotacion]));

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

  async reiniciar() {
    await this.prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        app.clientes,
        app.vehiculos,
        app.ordenes_servicio,
        app.servicios,
        app.repuestos,
        app.citas
      RESTART IDENTITY CASCADE
    `);
    return { ok: true };
  }

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
      await this.asegurarCatalogo(tx);
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
            ...(dto.pago ? { pago: leerJson(dto.pago) } : {}),
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

  async eliminar(numeroOs: string) {
    const orden = await this.prisma.ordenServicio.findUnique({ where: { numeroOs } });
    if (!orden) {
      throw new RpcException({ statusCode: 404, message: 'La orden no existe' });
    }
    await this.prisma.ordenServicio.delete({ where: { id: orden.id } });
    return { ok: true };
  }

  async listarInventario() {
    await this.prisma.$transaction((tx) => this.asegurarCatalogo(tx));
    const diasVentana = 90;
    const desde = new Date();
    desde.setHours(0, 0, 0, 0);
    desde.setDate(desde.getDate() - (diasVentana - 1));
    const [repuestos, movimientos] = await Promise.all([
      this.prisma.repuesto.findMany({ orderBy: { codigo: 'asc' } }),
      this.prisma.movimientoInventario.findMany({
        where: { fecha: { gte: desde } },
        orderBy: { fecha: 'desc' },
        include: { repuesto: { select: { codigo: true } } },
      }),
    ]);

    const dias: string[] = [];
    for (let i = 0; i < diasVentana; i++) {
      const dia = new Date(desde);
      dia.setDate(desde.getDate() + i);
      dias.push(claveDia(dia));
    }

    const salidasPorDia = new Map<string, Map<string, number>>();
    const salidas30 = new Map<string, number>();
    const recientes = new Map<
      string,
      { type: string; qty: number; date: string; note: string }[]
    >();
    const hace30 = new Date();
    hace30.setDate(hace30.getDate() - 30);

    for (const movimiento of movimientos) {
      const codigo = movimiento.repuesto.codigo;
      if (movimiento.tipo === 'salida') {
        const clave = claveDia(movimiento.fecha);
        const porDia = salidasPorDia.get(codigo) ?? new Map<string, number>();
        porDia.set(clave, (porDia.get(clave) ?? 0) + movimiento.cantidad);
        salidasPorDia.set(codigo, porDia);
        if (movimiento.fecha >= hace30) {
          salidas30.set(codigo, (salidas30.get(codigo) ?? 0) + movimiento.cantidad);
        }
      }
      const lista = recientes.get(codigo) ?? [];
      if (lista.length < 8) {
        lista.push({
          type: movimiento.tipo,
          qty: movimiento.cantidad,
          date: movimiento.fecha.toLocaleDateString('es-EC', {
            timeZone: 'America/Guayaquil',
          }),
          note: movimiento.nota ?? '',
        });
        recientes.set(codigo, lista);
      }
    }

    return repuestos.map((repuesto) => {
      const porDia = salidasPorDia.get(repuesto.codigo) ?? new Map<string, number>();
      const serieDiaria = dias.map((dia) => porDia.get(dia) ?? 0);
      const demanda30 = salidas30.get(repuesto.codigo) ?? 0;
      const rotacion =
        demanda30 >= 8
          ? 'Alta'
          : demanda30 >= 3
            ? 'Media'
            : demanda30 > 0
              ? 'Baja'
              : (ROTACION[repuesto.codigo] ?? 'Media');
      return {
        code: repuesto.codigo,
        name: repuesto.nombre,
        category: repuesto.categoria,
        stock: repuesto.stockActual,
        min: repuesto.stockMinimo,
        max: repuesto.stockMaximo,
        price: Number(repuesto.precioUnitario),
        rotation: rotacion,
        demanda30,
        coberturaDias:
          demanda30 > 0
            ? Math.round((repuesto.stockActual / demanda30) * 30)
            : null,
        sugerido: Math.max(
          0,
          repuesto.stockMinimo + demanda30 - repuesto.stockActual,
        ),
        fuente: 'local' as const,
        serieDiaria,
        movimientos: recientes.get(repuesto.codigo) ?? [],
      };
    });
  }

  async moverInventario(dto: { codigo: string; tipo: string; cantidad: number; nota?: string }) {
    if (!['entrada', 'salida'].includes(dto.tipo) || !Number.isInteger(dto.cantidad) || dto.cantidad < 1) {
      throw new RpcException({ statusCode: 400, message: 'El movimiento de stock no es válido' });
    }
    await this.prisma.$transaction(async (tx) => {
      const repuesto = await tx.repuesto.findUnique({ where: { codigo: dto.codigo } });
      if (!repuesto) {
        throw new RpcException({ statusCode: 404, message: 'El repuesto no existe' });
      }
      await this.aplicarStock(
        tx,
        repuesto.id,
        dto.tipo === 'entrada' ? dto.cantidad : -dto.cantidad,
        dto.nota?.trim() || (dto.tipo === 'entrada' ? 'Entrada manual' : 'Salida manual'),
      );
    });
    return this.listarInventario();
  }

  async crearRepuesto(dto: {
    nombre: string;
    categoria?: string;
    stock?: number;
    min?: number;
    max?: number;
    precio?: number;
  }) {
    const nombre = dto.nombre?.trim();
    if (!nombre) {
      throw new RpcException({ statusCode: 400, message: 'Escribe el nombre del repuesto' });
    }
    const total = await this.prisma.repuesto.count();
    const codigo = `REP-${String(total + 1).padStart(3, '0')}`;
    const stock = Math.max(0, Number(dto.stock) || 0);
    await this.prisma.repuesto.create({
      data: {
        codigo,
        nombre,
        categoria: dto.categoria?.trim() || 'General',
        precioUnitario: Number(dto.precio) || 0,
        stockActual: stock,
        stockMinimo: Math.max(0, Number(dto.min) || 0),
        stockMaximo: Math.max(0, Number(dto.max) || 0),
      },
    });
    if (stock > 0) {
      const creado = await this.prisma.repuesto.findUniqueOrThrow({ where: { codigo } });
      await this.prisma.movimientoInventario.create({
        data: { repuestoId: creado.id, tipo: 'entrada', cantidad: stock, nota: 'Stock inicial' },
      });
    }
    return this.listarInventario();
  }

  async listarCitas() {
    const citas = await this.prisma.cita.findMany({ orderBy: [{ fecha: 'asc' }, { hora: 'asc' }] });
    return citas.map((cita) => this.presentarCita(cita));
  }

  async guardarCita(dto: {
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
    const nombre = dto.nombreCliente?.trim();
    const servicio = dto.servicio?.trim();
    if (!nombre || !servicio || !dto.fecha || !dto.hora || !dto.mecanico) {
      throw new RpcException({ statusCode: 400, message: 'Completa el cliente, el servicio, la fecha y la hora' });
    }
    const estado = ['pendiente', 'confirmada', 'cancelada'].includes(dto.estado ?? '')
      ? dto.estado!
      : 'pendiente';
    const data = {
      nombreCliente: nombre,
      telefono: dto.telefono?.trim() ?? '',
      placa: dto.placa?.trim().toUpperCase() ?? '',
      servicio,
      fecha: dto.fecha,
      hora: dto.hora,
      mecanico: dto.mecanico,
      notas: dto.notas?.trim() ?? '',
      estado,
    };
    const cita = dto.id
      ? await this.prisma.cita.update({ where: { id: dto.id }, data })
      : await this.prisma.cita.create({ data });
    return this.presentarCita(cita);
  }

  private presentarCita(cita: {
    id: number;
    nombreCliente: string;
    telefono: string;
    placa: string;
    servicio: string;
    fecha: string;
    hora: string;
    mecanico: string;
    notas: string;
    estado: string;
  }) {
    return {
      id: String(cita.id),
      clientName: cita.nombreCliente,
      clientPhone: cita.telefono,
      plate: cita.placa,
      service: cita.servicio,
      date: cita.fecha,
      time: cita.hora,
      mechanic: cita.mecanico,
      notes: cita.notas,
      status: cita.estado,
    };
  }

  private async asegurarCatalogo(tx: Tx) {
    for (const item of CATALOGO) {
      const actual = await tx.repuesto.findUnique({ where: { codigo: item.codigo } });
      if (!actual) {
        await tx.repuesto.create({
          data: {
            codigo: item.codigo,
            nombre: item.nombre,
            categoria: item.categoria,
            precioUnitario: item.precio,
            stockActual: item.stock,
            stockMinimo: item.min,
            stockMaximo: item.max,
          },
        });
        continue;
      }
      const movimientos = await tx.movimientoInventario.count({ where: { repuestoId: actual.id } });
      if (actual.stockActual === 0 && movimientos === 0) {
        await tx.repuesto.update({
          where: { id: actual.id },
          data: {
            stockActual: item.stock,
            stockMinimo: item.min,
            stockMaximo: item.max,
          },
        });
      }
    }
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
    const porContacto = await this.buscarClientePorContacto(tx, data.telefono, data.email);
    if (porContacto) {
      return tx.cliente.update({ where: { id: porContacto.id }, data });
    }
    return tx.cliente.create({ data });
  }

  private async buscarClientePorContacto(tx: Tx, telefono: string | null, email: string | null) {
    const digitos = telefono?.replace(/\D/g, '') ?? '';
    if (digitos) {
      const conTelefono = await tx.cliente.findMany({
        where: { telefono: { not: null } },
        select: { id: true, telefono: true },
      });
      const hallado = conTelefono.find(
        (item) => item.telefono?.replace(/\D/g, '') === digitos,
      );
      if (hallado) return hallado;
    }
    if (!email) return null;
    return tx.cliente.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
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
      ...(dto.diagnostico ? { diagnostico: leerDiagnostico(dto.diagnostico) } : {}),
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
    const previos = await tx.detalleRepuestoOrden.findMany({
      where: { ordenId, usado: true },
      select: { repuestoId: true, cantidad: true },
    });
    const usadoAntes = new Map<number, number>();
    for (const linea of previos) {
      usadoAntes.set(linea.repuestoId, (usadoAntes.get(linea.repuestoId) ?? 0) + linea.cantidad);
    }

    await tx.detalleRepuestoOrden.deleteMany({ where: { ordenId } });
    const usadoAhora = new Map<number, number>();
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
      if (linea.usado) {
        usadoAhora.set(repuesto.id, (usadoAhora.get(repuesto.id) ?? 0) + linea.cantidad);
      }
    }

    const ids = new Set([...usadoAntes.keys(), ...usadoAhora.keys()]);
    for (const id of ids) {
      const delta = (usadoAhora.get(id) ?? 0) - (usadoAntes.get(id) ?? 0);
      if (delta === 0) continue;
      await this.aplicarStock(tx, id, -delta, delta > 0 ? 'Uso en orden' : 'Ajuste al desmarcar el uso');
    }
  }

  private async aplicarStock(tx: Tx, repuestoId: number, delta: number, nota: string) {
    const repuesto = await tx.repuesto.findUniqueOrThrow({ where: { id: repuestoId } });
    const siguiente = repuesto.stockActual + delta;
    if (siguiente < 0) {
      throw new RpcException({
        statusCode: 400,
        message: `Stock insuficiente de ${repuesto.nombre}. Disponible: ${repuesto.stockActual}`,
      });
    }
    await tx.repuesto.update({
      where: { id: repuestoId },
      data: { stockActual: siguiente },
    });
    await tx.movimientoInventario.create({
      data: {
        repuestoId,
        tipo: delta >= 0 ? 'entrada' : 'salida',
        cantidad: Math.abs(delta),
        nota,
      },
    });
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
        diagnosis: orden.diagnostico ?? undefined,
        payment: orden.pago ?? undefined,
      },
    };
  }
}

function leerJson(valor: string): Prisma.InputJsonValue {
  return leerDiagnostico(valor);
}

function leerDiagnostico(valor: string): Prisma.InputJsonValue {
  try {
    const datos = JSON.parse(valor) as unknown;
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
      throw new Error('forma');
    }
    return datos as Prisma.InputJsonValue;
  } catch {
    throw new RpcException({
      statusCode: 400,
      message: 'El diagnóstico guardado no tiene un formato válido',
    });
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

function claveDia(fecha: Date) {
  return fecha.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
}
