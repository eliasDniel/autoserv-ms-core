import 'dotenv/config';
import * as joi from 'joi';

interface EnvVars {
  NATS_SERVICE: string;
  DATABASE_URL: string;
}

const envsSchema = joi
  .object({
    NATS_SERVICE: joi.string().required(),
    DATABASE_URL: joi.string().required(),
  })
  .unknown(true);

const result: { error?: { message: string }; value: EnvVars } =
  envsSchema.validate(process.env);

if (result.error) {
  throw new Error(
    `Error en la configuracion de la validacion ${result.error.message}`,
  );
}

const envVars = result.value;

export const envs = {
  natsService: envVars.NATS_SERVICE,
  dataBaseUrl: envVars.DATABASE_URL,
};
