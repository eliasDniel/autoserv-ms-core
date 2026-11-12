import { randomBytes } from 'crypto';
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
        app.citas,
        app.horarios_taller
      RESTART IDENTITY CASCADE
    `);
    await this.asegurarHorariosTaller();
    return { ok: true };
  }

  async listar() {
    const [ordenes, clientesDb] = await Promise.all([
      this.prisma.ordenServicio.findMany({
        include: ordenInclude,
        orderBy: { fechaIngreso: 'desc' },
      }),
      this.prisma.cliente.findMany({
        include: { vehiculos: true },
        orderBy: { nombre: 'asc' },
      }),
    ]);
    const bundles = ordenes.map((orden) => this.presentar(orden));
    return {
      clientes: clientesDb.map((c) => this.presentarCliente(c)),
      vehiculos: clientesDb.flatMap((c) =>
        c.vehiculos.map((v) => this.presentarVehiculo(v, c.id)),
      ),
      ordenes: bundles.map((item) => item.orden),
    };
  }

  async guardarCliente(dto: {
    id?: number | string;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    city?: string;
    cedula?: string;
  }) {
    const nombre = dto.name?.trim();
    if (!nombre) {
      throw new RpcException({ statusCode: 400, message: 'El nombre del cliente es obligatorio' });
    }
    const data = {
      nombre,
      telefono: vacio(dto.phone),
      email: vacio(dto.email),
      direccion: vacio(dto.address),
      ciudad: vacio(dto.city),
      cedula: vacio(dto.cedula),
    };
    const id = dto.id ? Number(dto.id) : NaN;
    const fila = Number.isFinite(id)
      ? await this.prisma.cliente.update({ where: { id }, data })
      : await this.prisma.cliente.create({ data });
    return this.presentarCliente(fila);
  }

  async eliminarCliente(idRaw: number | string) {
    const id = Number(idRaw);
    if (!Number.isFinite(id)) {
      throw new RpcException({ statusCode: 400, message: 'Cliente inválido' });
    }
    const cliente = await this.prisma.cliente.findUnique({
      where: { id },
      include: { vehiculos: { include: { ordenes: { select: { id: true }, take: 1 } } }, citas: { take: 1 } },
    });
    if (!cliente) {
      throw new RpcException({ statusCode: 404, message: 'Cliente no encontrado' });
    }
    const conOrdenes = cliente.vehiculos.some((v) => v.ordenes.length > 0);
    if (conOrdenes || cliente.citas.length > 0) {
      throw new RpcException({
        statusCode: 400,
        message: 'No se puede eliminar: el cliente tiene órdenes o citas',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.vehiculo.deleteMany({ where: { clienteId: id } });
      await tx.cliente.delete({ where: { id } });
    });
    return { ok: true };
  }

  async guardarVehiculo(dto: {
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
    const clienteId = Number(dto.clientId);
    const placa = dto.plate?.trim().toUpperCase();
    if (!Number.isFinite(clienteId) || !placa || !dto.brand?.trim() || !dto.model?.trim()) {
      throw new RpcException({
        statusCode: 400,
        message: 'Completa cliente, placa, marca y modelo',
      });
    }
    const cliente = await this.prisma.cliente.findUnique({ where: { id: clienteId } });
    if (!cliente) {
      throw new RpcException({ statusCode: 404, message: 'Cliente no encontrado' });
    }
    const data = {
      clienteId,
      placa,
      marca: dto.brand.trim(),
      modelo: dto.model.trim(),
      anio: Number(dto.year) || new Date().getFullYear(),
      color: vacio(dto.color),
      vin: vacio(dto.vin),
      motor: vacio(dto.engine),
      combustible: vacio(dto.fuel),
      transmision: vacio(dto.transmission),
      kilometraje: Math.max(0, Number(dto.km) || 0),
    };
    const id = dto.id ? Number(dto.id) : NaN;
    const fila = Number.isFinite(id)
      ? await this.prisma.vehiculo.update({ where: { id }, data })
      : await this.prisma.vehiculo.upsert({
          where: { placa },
          update: data,
          create: data,
        });
    return this.presentarVehiculo(fila, clienteId);
  }

  async eliminarVehiculo(idRaw: number | string) {
    const id = Number(idRaw);
    if (!Number.isFinite(id)) {
      throw new RpcException({ statusCode: 400, message: 'Vehículo inválido' });
    }
    const vehiculo = await this.prisma.vehiculo.findUnique({
      where: { id },
      include: { ordenes: { take: 1 }, citas: { take: 1 } },
    });
    if (!vehiculo) {
      throw new RpcException({ statusCode: 404, message: 'Vehículo no encontrado' });
    }
    if (vehiculo.ordenes.length > 0 || vehiculo.citas.length > 0) {
      throw new RpcException({
        statusCode: 400,
        message: 'No se puede eliminar: el vehículo tiene órdenes o citas',
      });
    }
    await this.prisma.vehiculo.delete({ where: { id } });
    return { ok: true };
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
    codigo?: string;
    nombre: string;
    categoria?: string;
    stock?: number;
    min?: number;
    max?: number;
    precio?: number;
    /** Solo import CSV: alinea stockActual al valor del archivo */
    sincronizarStock?: boolean;
  }) {
    const nombre = dto.nombre?.trim();
    if (!nombre) {
      throw new RpcException({ statusCode: 400, message: 'Escribe el nombre del repuesto' });
    }
    const total = await this.prisma.repuesto.count();
    const codigo = (dto.codigo?.trim() || `REP-${String(total + 1).padStart(3, '0')}`).toUpperCase();
    const stock = Math.max(0, Number(dto.stock) || 0);
    const min = Math.max(0, Number(dto.min) || 0);
    const max = Math.max(0, Number(dto.max) || 0);
    const precio = Number(dto.precio) || 0;
    const categoria = dto.categoria?.trim() || 'General';
    const existente = await this.prisma.repuesto.findUnique({ where: { codigo } });
    if (existente) {
      const data: {
        nombre: string;
        categoria: string;
        precioUnitario: number;
        stockMinimo: number;
        stockMaximo: number;
        stockActual?: number;
      } = {
        nombre,
        categoria,
        precioUnitario: precio,
        stockMinimo: min,
        stockMaximo: max,
      };
      if (dto.sincronizarStock) {
        data.stockActual = stock;
      }
      await this.prisma.repuesto.update({
        where: { id: existente.id },
        data,
      });
      if (dto.sincronizarStock && stock !== existente.stockActual) {
        const delta = stock - existente.stockActual;
        await this.prisma.movimientoInventario.create({
          data: {
            repuestoId: existente.id,
            tipo: delta >= 0 ? 'entrada' : 'salida',
            cantidad: Math.abs(delta),
            nota: 'Ajuste por importación CSV',
          },
        });
      }
      return this.listarInventario();
    }
    await this.prisma.repuesto.create({
      data: {
        codigo,
        nombre,
        categoria,
        precioUnitario: precio,
        stockActual: stock,
        stockMinimo: min,
        stockMaximo: max,
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

  async eliminarRepuesto(codigo: string) {
    const fila = await this.prisma.repuesto.findUnique({ where: { codigo } });
    if (!fila) {
      throw new RpcException({ statusCode: 404, message: 'Repuesto no encontrado' });
    }
    const enOrdenes = await this.prisma.detalleRepuestoOrden.count({
      where: { repuestoId: fila.id },
    });
    if (enOrdenes > 0) {
      throw new RpcException({
        statusCode: 400,
        message: 'No se puede eliminar: el repuesto está usado en órdenes',
      });
    }
    await this.prisma.repuesto.delete({ where: { id: fila.id } });
    return this.listarInventario();
  }

  async importarRepuestos(filas: {
    codigo: string;
    nombre: string;
    categoria?: string;
    stock?: number;
    min?: number;
    max?: number;
    precio?: number;
  }[]) {
    for (const fila of filas) {
      await this.crearRepuesto({ ...fila, sincronizarStock: true });
    }
    return this.listarInventario();
  }

  async listarCitas() {
    await this.asegurarHorariosTaller();
    const citas = await this.prisma.cita.findMany({ orderBy: [{ fecha: 'asc' }, { hora: 'asc' }] });
    return citas.map((cita) => this.presentarCita(cita));
  }

  async horasLibres(dto: { fecha: string; servicioId?: number }) {
    await this.asegurarHorariosTaller();
    const fecha = dto.fecha?.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '')) {
      throw new RpcException({ statusCode: 400, message: 'Fecha inválida (YYYY-MM-DD)' });
    }
    const dia = diaSemanaGuayaquil(fecha!);
    const horario = await this.prisma.horarioTaller.findUnique({ where: { diaSemana: dia } });
    if (!horario) {
      return { fecha, horas: [] as string[] };
    }
    const slots = generarSlots(horario.horaInicio, horario.horaFin, horario.intervaloMin);
    const ocupadas = await this.prisma.cita.findMany({
      where: {
        fecha: fecha!,
        estado: { not: 'cancelada' },
      },
      select: { hora: true },
    });
    const tomadas = new Set(ocupadas.map((c) => c.hora));
    return {
      fecha,
      horas: slots.filter((h) => !tomadas.has(h)),
      intervaloMin: horario.intervaloMin,
    };
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
    origen?: string;
    telegramChatId?: string;
    clienteId?: number;
    vehiculoId?: number;
    servicioId?: number;
  }) {
    const nombre = dto.nombreCliente?.trim();
    const servicio = dto.servicio?.trim();
    if (!nombre || !servicio || !dto.fecha || !dto.hora || !dto.mecanico) {
      throw new RpcException({ statusCode: 400, message: 'Completa el cliente, el servicio, la fecha y la hora' });
    }
    const estado = ['pendiente', 'confirmada', 'cancelada'].includes(dto.estado ?? '')
      ? dto.estado!
      : 'pendiente';
    const origen = dto.origen === 'telegram' ? 'telegram' : 'web';
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
      origen,
      telegramChatId: vacio(dto.telegramChatId),
      clienteId: dto.clienteId ?? null,
      vehiculoId: dto.vehiculoId ?? null,
      servicioId: dto.servicioId ?? null,
    };

    if (!dto.id) {
      const choque = await this.prisma.cita.findFirst({
        where: {
          fecha: data.fecha,
          hora: data.hora,
          mecanico: data.mecanico,
          estado: { not: 'cancelada' },
        },
      });
      if (choque) {
        throw new RpcException({
          statusCode: 409,
          message: 'Ese horario ya fue tomado, intenta otro',
        });
      }
    }

    const cita = dto.id
      ? await this.prisma.cita.update({ where: { id: dto.id }, data })
      : await this.prisma.cita.create({ data });
    return this.presentarCita(cita);
  }

  async vincularTelegram(dto: {
    token?: string;
    telefono?: string;
    cedula?: string;
    chatId: string;
    nombre?: string;
  }) {
    const chatId = String(dto.chatId ?? '').trim();
    if (!chatId) {
      throw new RpcException({ statusCode: 400, message: 'chatId requerido' });
    }

    let cliente = null as Awaited<ReturnType<typeof this.prisma.cliente.findFirst>>;

    if (dto.token?.trim()) {
      cliente = await this.prisma.cliente.findFirst({
        where: {
          telegramVinculoToken: dto.token.trim(),
          telegramVinculoExpira: { gt: new Date() },
        },
      });
      if (!cliente) {
        throw new RpcException({ statusCode: 400, message: 'El enlace de vinculación no es válido o expiró' });
      }
    } else {
      const telefono = dto.telefono?.trim();
      const cedula = dto.cedula?.trim();
      if (!telefono && !cedula) {
        throw new RpcException({ statusCode: 400, message: 'Indica teléfono o cédula para vincular' });
      }
      cliente = await this.prisma.cliente.findFirst({
        where: {
          OR: [
            ...(telefono ? [{ telefono }] : []),
            ...(cedula ? [{ cedula }] : []),
          ],
        },
      });
      if (!cliente) {
        cliente = await this.prisma.cliente.create({
          data: {
            nombre: dto.nombre?.trim() || 'Cliente Telegram',
            telefono: telefono || null,
            cedula: cedula || null,
          },
        });
      }
    }

    const actualizado = await this.prisma.cliente.update({
      where: { id: cliente.id },
      data: {
        telegramChatId: chatId,
        telegramVinculoToken: null,
        telegramVinculoExpira: null,
      },
      include: { vehiculos: true },
    });
    return this.presentarClienteTelegram(actualizado);
  }

  async crearVinculoTelegram(dto: { clienteId: number }) {
    const cliente = await this.prisma.cliente.findUnique({ where: { id: dto.clienteId } });
    if (!cliente) {
      throw new RpcException({ statusCode: 404, message: 'Cliente no encontrado' });
    }
    const token = randomToken();
    const expira = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.prisma.cliente.update({
      where: { id: cliente.id },
      data: {
        telegramVinculoToken: token,
        telegramVinculoExpira: expira,
      },
    });
    return { token, expira: expira.toISOString(), clienteId: cliente.id };
  }

  async clientePorChat(dto: { chatId: string }) {
    const chatId = String(dto.chatId ?? '').trim();
    const cliente = await this.prisma.cliente.findFirst({
      where: { telegramChatId: chatId },
      include: { vehiculos: true },
    });
    if (!cliente) {
      return null;
    }
    return this.presentarClienteTelegram(cliente);
  }

  async citasPorChat(dto: { chatId: string }) {
    const chatId = String(dto.chatId ?? '').trim();
    const citas = await this.prisma.cita.findMany({
      where: {
        telegramChatId: chatId,
        estado: { not: 'cancelada' },
      },
      orderBy: [{ fecha: 'asc' }, { hora: 'asc' }],
    });
    return citas.map((cita) => this.presentarCita(cita));
  }

  async cancelarCitaTelegram(dto: { id: number; chatId: string }) {
    const cita = await this.prisma.cita.findUnique({ where: { id: dto.id } });
    if (!cita || cita.telegramChatId !== String(dto.chatId)) {
      throw new RpcException({ statusCode: 404, message: 'Cita no encontrada' });
    }
    const actualizada = await this.prisma.cita.update({
      where: { id: cita.id },
      data: { estado: 'cancelada' },
    });
    return this.presentarCita(actualizada);
  }

  async confirmarCitaTelegram(dto: { id: number; chatId: string }) {
    const cita = await this.prisma.cita.findUnique({ where: { id: dto.id } });
    if (!cita || cita.telegramChatId !== String(dto.chatId)) {
      throw new RpcException({ statusCode: 404, message: 'Cita no encontrada' });
    }
    const actualizada = await this.prisma.cita.update({
      where: { id: cita.id },
      data: { estado: 'confirmada' },
    });
    return this.presentarCita(actualizada);
  }

  async citasParaRecordatorio(dto: { ventana: '24h' | '2h' }) {
    const ahora = ahoraGuayaquil();
    const citas = await this.prisma.cita.findMany({
      where: {
        estado: { in: ['pendiente', 'confirmada'] },
        telegramChatId: { not: null },
        ...(dto.ventana === '24h'
          ? { recordatorio24hEnviado: false }
          : { recordatorio2hEnviado: false }),
      },
    });
    const candidatas = citas.filter((cita) => {
      const inicio = Date.parse(`${cita.fecha}T${cita.hora}:00-05:00`);
      if (Number.isNaN(inicio)) return false;
      const diffH = (inicio - ahora.getTime()) / 36e5;
      if (dto.ventana === '24h') return diffH > 20 && diffH <= 24.5;
      return diffH > 1.5 && diffH <= 2.5;
    });
    return candidatas.map((cita) => this.presentarCita(cita));
  }

  async marcarRecordatorio(dto: { id: number; ventana: '24h' | '2h' }) {
    await this.prisma.cita.update({
      where: { id: dto.id },
      data:
        dto.ventana === '24h'
          ? { recordatorio24hEnviado: true }
          : { recordatorio2hEnviado: true },
    });
    return { ok: true };
  }

  private async asegurarHorariosTaller() {
    const total = await this.prisma.horarioTaller.count();
    if (total > 0) return;
    const dias = [1, 2, 3, 4, 5, 6]; // Lun-Sáb
    for (const dia of dias) {
      await this.prisma.horarioTaller.create({
        data: {
          diaSemana: dia,
          horaInicio: '08:00',
          horaFin: '17:00',
          intervaloMin: 60,
        },
      });
    }
  }

  private presentarClienteTelegram(cliente: {
    id: number;
    nombre: string;
    telefono: string | null;
    cedula: string | null;
    telegramChatId: string | null;
    vehiculos: { id: number; placa: string; marca: string; modelo: string }[];
  }) {
    return {
      id: cliente.id,
      nombre: cliente.nombre,
      telefono: cliente.telefono ?? '',
      cedula: cliente.cedula ?? '',
      telegramChatId: cliente.telegramChatId,
      vehiculos: cliente.vehiculos.map((v) => ({
        id: v.id,
        placa: v.placa,
        marca: v.marca,
        modelo: v.modelo,
        label: `${v.placa} · ${v.marca} ${v.modelo}`,
      })),
    };
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
    origen?: string;
    telegramChatId?: string | null;
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
      origen: cita.origen ?? 'web',
      telegramChatId: cita.telegramChatId ?? undefined,
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
    const data = {
      vehiculoId,
      nombreAsesor: dto.nombreAsesor,
      kilometrajeIngreso: dto.vehiculo.kilometraje,
      nivelCombustible: dto.nivelCombustible,
      tieneLlaves: dto.tieneLlaves,
      tieneAlarma: dto.tieneAlarma,
      claveVehiculo: vacio(dto.claveVehiculo),
      observacionesCliente: vacio(dto.observacionesCliente),
      notasTecnico: vacio(dto.notasTecnico),
      notasInspeccion: vacio(dto.notasInspeccion),
      autorizacionFirmada: dto.autorizacionFirmada,
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

  async listarServicios() {
    const filas = await this.prisma.servicio.findMany({ orderBy: { codigo: 'asc' } });
    if (filas.length === 0) {
      await this.sembrarServiciosBase();
      const sembrados = await this.prisma.servicio.findMany({ orderBy: { codigo: 'asc' } });
      return sembrados.map(mapServicio);
    }
    return filas.map(mapServicio);
  }

  async guardarServicio(dto: {
    codigo?: string;
    nombre: string;
    tiempo: string;
    precio: number;
  }) {
    const nombre = dto.nombre?.trim();
    const tiempo = dto.tiempo?.trim() || '1h';
    if (!nombre) {
      throw new RpcException({ statusCode: 400, message: 'El nombre del servicio es obligatorio' });
    }
    const codigo = (dto.codigo?.trim() || (await this.siguienteCodigoServicio())).toUpperCase();
    const fila = await this.prisma.servicio.upsert({
      where: { codigo },
      update: {
        nombre,
        precio: dto.precio,
        tiempoEstimadoMin: minutos(tiempo),
      },
      create: {
        codigo,
        nombre,
        precio: dto.precio,
        tiempoEstimadoMin: minutos(tiempo),
      },
    });
    return mapServicio(fila);
  }

  async eliminarServicio(codigo: string) {
    const fila = await this.prisma.servicio.findUnique({ where: { codigo } });
    if (!fila) {
      throw new RpcException({ statusCode: 404, message: 'Servicio no encontrado' });
    }
    const enUso = await this.prisma.ordenServicioServicio.count({
      where: { servicioId: fila.id },
    });
    if (enUso > 0) {
      throw new RpcException({
        statusCode: 400,
        message: 'No se puede eliminar: el servicio está usado en órdenes',
      });
    }
    await this.prisma.servicio.delete({ where: { id: fila.id } });
    return { ok: true };
  }

  async importarServicios(filas: { codigo: string; nombre: string; tiempo: string; precio: number }[]) {
    const guardados: { code: string; name: string; time: string; price: number }[] = [];
    for (const fila of filas) {
      guardados.push(
        await this.guardarServicio({
          codigo: fila.codigo,
          nombre: fila.nombre,
          tiempo: fila.tiempo,
          precio: fila.precio,
        }),
      );
    }
    return guardados;
  }

  private async sembrarServiciosBase() {
    const base = [
      { codigo: 'SRV-001', nombre: 'Cambio de aceite y filtro', tiempo: '1h', precio: 45 },
      { codigo: 'SRV-002', nombre: 'Revisión de suspensión delantera', tiempo: '2h', precio: 80 },
      { codigo: 'SRV-003', nombre: 'Revisión sistema A/C', tiempo: '1.5h', precio: 60 },
      { codigo: 'SRV-004', nombre: 'Revisión y calibración de llantas', tiempo: '0.5h', precio: 20 },
      { codigo: 'SRV-005', nombre: 'Cambio de pastillas de freno', tiempo: '1.5h', precio: 150 },
      { codigo: 'SRV-006', nombre: 'Revisión general del vehículo', tiempo: '1h', precio: 80 },
      { codigo: 'SRV-007', nombre: 'Alineación y balanceo', tiempo: '1h', precio: 40 },
      { codigo: 'SRV-008', nombre: 'Diagnóstico computarizado', tiempo: '0.5h', precio: 35 },
      { codigo: 'SRV-016', nombre: 'Cambio de filtro de combustible / gasolina', tiempo: '0.75h', precio: 35 },
    ];
    for (const item of base) {
      await this.prisma.servicio.upsert({
        where: { codigo: item.codigo },
        update: {},
        create: {
          codigo: item.codigo,
          nombre: item.nombre,
          precio: item.precio,
          tiempoEstimadoMin: minutos(item.tiempo),
        },
      });
    }
  }

  private async siguienteCodigoServicio() {
    const filas = await this.prisma.servicio.findMany({ select: { codigo: true } });
    let max = 0;
    for (const fila of filas) {
      const match = /^SRV-(\d+)$/i.exec(fila.codigo);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `SRV-${String(max + 1).padStart(3, '0')}`;
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

  private presentarCliente(cliente: {
    id: number;
    nombre: string;
    telefono: string | null;
    email: string | null;
    direccion: string | null;
    ciudad: string | null;
  }) {
    return {
      id: String(cliente.id),
      name: cliente.nombre,
      phone: cliente.telefono ?? '',
      email: cliente.email ?? '',
      address: cliente.direccion ?? '',
      city: cliente.ciudad ?? '',
    };
  }

  private presentarVehiculo(
    vehiculo: {
      id: number;
      placa: string;
      marca: string;
      modelo: string;
      anio: number;
      color: string | null;
      vin: string | null;
      motor: string | null;
      combustible: string | null;
      transmision: string | null;
      kilometraje: number;
    },
    clienteId: number,
  ) {
    return {
      id: String(vehiculo.id),
      clientId: String(clienteId),
      plate: vehiculo.placa,
      brand: vehiculo.marca,
      model: vehiculo.modelo,
      year: String(vehiculo.anio),
      color: vehiculo.color ?? '',
      vin: vehiculo.vin ?? '',
      engine: vehiculo.motor ?? '',
      fuel: vehiculo.combustible ?? '',
      transmission: vehiculo.transmision ?? '',
      km: vehiculo.kilometraje,
    };
  }

  private presentar(orden: OrdenCompleta) {
    const danos = new Set(orden.inspecciones.map((item) => item.zona));
    const partes = Object.fromEntries(ZONAS.map((zona) => [zona, !danos.has(zona)]));
    const cliente = orden.vehiculo.cliente;
    return {
      cliente: this.presentarCliente(cliente),
      vehiculo: this.presentarVehiculo(orden.vehiculo, cliente.id),
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
        vehicleKey: orden.claveVehiculo ?? '',
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

function etiquetaTiempo(minutosEstimados: number) {
  if (minutosEstimados % 60 === 0) return `${minutosEstimados / 60}h`;
  const horas = minutosEstimados / 60;
  return `${Number(horas.toFixed(2))}h`.replace(/\.?0+h$/, 'h').replace(/(\.\d*?)0+h$/, '$1h');
}

function mapServicio(fila: {
  codigo: string;
  nombre: string;
  tiempoEstimadoMin: number;
  precio: { toNumber?: () => number } | number | string;
}) {
  const precio =
    typeof fila.precio === 'object' && fila.precio && 'toNumber' in fila.precio
      ? fila.precio.toNumber!()
      : Number(fila.precio);
  return {
    code: fila.codigo,
    name: fila.nombre,
    time: etiquetaTiempo(fila.tiempoEstimadoMin),
    price: precio,
  };
}

function claveDia(fecha: Date) {
  return fecha.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
}

function randomToken() {
  return randomBytes(16).toString('hex');
}

function ahoraGuayaquil() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }),
  );
}

/** 0=domingo … 6=sábado en America/Guayaquil */
function diaSemanaGuayaquil(fechaIso: string) {
  const d = new Date(`${fechaIso}T12:00:00-05:00`);
  return d.getUTCDay();
}

function generarSlots(horaInicio: string, horaFin: string, intervaloMin: number) {
  const aMin = (h: string) => {
    const [hh, mm] = h.split(':').map(Number);
    return hh * 60 + mm;
  };
  const aHora = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const slots: string[] = [];
  for (let m = aMin(horaInicio); m < aMin(horaFin); m += intervaloMin) {
    slots.push(aHora(m));
  }
  return slots;
}
