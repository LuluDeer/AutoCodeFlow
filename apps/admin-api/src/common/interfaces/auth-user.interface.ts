import { UserRole } from "../../modules/users/entities/user.entity";

/**
 * Shape of the authenticated user injected into request by JwtStrategy.validate().
 * Matches the User entity fields returned by UsersService.findById().
 */
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}
