import { SetMetadata } from "@nestjs/common";
import { UserRole } from "../../modules/users/entities/user.entity";

export const ROLES_KEY = "roles";

/**
 * Decorator to restrict a route to specific user roles.
 * Usage: @Roles(UserRole.ADMIN)
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
